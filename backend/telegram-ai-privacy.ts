import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createConversationPrivacy,maskProtocolQuestion,containsUnmaskedPersonalData,normalizePrivacyText,isPersonalDataField,type PrivacyPerson} from './telegram-conversation-privacy.ts';
type Settings={enabled:()=>boolean;secret:string;loadPeople:()=>Promise<PrivacyPerson[]>;audit:(record:{id:string;scopeHash:string;provider:string;model:string;payload:unknown;payloadHash:string})=>Promise<void>;approvedMedia?:(sha256:string,mime:string)=>Promise<boolean>};
const scopes=new AsyncLocalStorage<string>();let settings:Settings|undefined;
export class AiPrivacyError extends Error{constructor(){super('No se puede enviar este contenido a IA hasta completar su revisión de privacidad.');}}
export function configureAiPrivacy(value:Settings|undefined){settings=value;}
export function withAiPrivacyScope<T>(scope:string,run:()=>T):T{return scopes.run(scope,run);}
export function conversationPersonMarker(personId:string):string{
 const config=configured(),scope=scopes.getStore();if(!config||!scope||!personId||personId.length>255)throw new AiPrivacyError();
 return '[PERSONA:'+createHmac('sha256',config.secret).update(scope+'\0'+personId).digest('hex').slice(0,16)+']';
}
function configured(){if(!settings){if(process.env.NODE_ENV==='test'&&process.env.AI_PRIVACY_ENABLED!=='true')return null;throw new AiPrivacyError();}if(!settings.enabled()||settings.secret.length<32)throw new AiPrivacyError();return settings;}
async function privacyOperation<T>(operation:()=>Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([operation(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new AiPrivacyError()),2000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
function knownFreeText(value:string){
 // Machine provenance is explicitly not a telephone or a person's identity.
 return value.split(/(\[PERSONA:[a-f0-9]{16}\])/giu);
}
export async function prepareAiPayload<T>(payload:T,provider:string,model:string):Promise<T>{
 const config=configured();if(!config)return payload;
 const scope=scopes.getStore()||'agent-default',people=[...await privacyOperation(config.loadPeople)];
 const texts:string[]=[];const collect=(v:unknown)=>{if(typeof v==='string')texts.push(v);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')Object.values(v).forEach(collect);};collect(payload);
 const normalized=(name:string)=>name.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/gu,' ').trim();
 const known=new Set(people.flatMap(p=>[p.name,...p.aliases||[]]).map(normalized));const unknown=new Map<string,string>();
 for(const original of texts){const text=normalizePrivacyText(original);
  for(const m of text.matchAll(/^\s*\[[^\]\n]{1,60}\]\s+([^\n]{3,100}?):\s/gmu))if(!/\[PERSONA:[a-f0-9]{16}\]/u.test(m[1]))unknown.set(normalized(m[1]),m[1].trim());
  for(const m of text.matchAll(/\b(?:[Cc]liente|[Tt]itular|[Pp]ropietari[oa]|[Cc]ontacto|[Mm]e llamo|[Ss]oy|[Hh]abla con|[Ll]lama a|[Aa] nombre de)\s*[:=]?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/gu))unknown.set(normalized(m[1]),m[1].trim());
  for(const mention of text.matchAll(/\b(?:cliente|titular|propietari[oa]|contacto|me llamo|soy|habla con|llama a|a nombre de)\s*[:=]?\s+([^\n.;!?]{2,180})/giu)){
   const match=/^([\p{Lu}]{2,}(?:\s+[\p{Lu}]{2,}){0,3})(?!\p{L})/u.exec(mention[1]);
   const name=match?.[1].split(/\s+(?:CONFIRMO|NECESITO|PARA|QUE|ESTOY|SOLICITO)\b/u)[0].trim();if(name)unknown.set(normalized(name),name);
  }
 }
 for(const [canonical,name] of unknown)if(!known.has(canonical)&&!['pmc','director','equipo','equipo lyn','cliente','cliente verificado','autor no identificado','subcontrata','sistema','bot','grupo lyn'].includes(canonical))people.push({id:'transcript:'+createHmac('sha256',config.secret).update(scope+'\0'+canonical).digest('hex'),name});
 const context=createConversationPrivacy(scope,[...people],config.secret);
 const markers=new Set(people.map(p=>'[PERSONA:'+createHmac('sha256',config.secret).update(scope+'\0'+p.id).digest('hex').slice(0,16)+']'));
 const media:any[]=[];const collectMedia=(v:any)=>{if(Array.isArray(v))v.forEach(collectMedia);else if(v&&typeof v==='object'){if(['audio','image','video','document'].includes(v.type)&&typeof v.data==='string')media.push(v);Object.values(v).forEach(collectMedia);}};collectMedia(payload);
 for(const item of media)await assertAiMediaApproved(Buffer.from(item.data,'base64'),String(item.mime_type||''));
 const redact=(v:any):any=>{
  if(typeof v==='string')return knownFreeText(v).map((part,index)=>{
   if(index%2)return markers.has(part)?part:'[MARCADOR_NO_VERIFICADO]';const masked=maskProtocolQuestion(part,context);if(containsUnmaskedPersonalData(masked))throw new AiPrivacyError();return masked;
  }).join('');
  if(Array.isArray(v))return v.map(redact);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,key==='data'&&media.includes(v)?value:value!=null&&isPersonalDataField(key)?'[DATO_PERSONAL:'+createHmac('sha256',config.secret).update(scope+'\0'+key+'\0'+JSON.stringify(value)).digest('hex').slice(0,16)+']':redact(value)]));
  return v;
 };
 const safe=redact(payload) as T;
 const auditCopy=(v:any):any=>Array.isArray(v)?v.map(auditCopy):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([key,value])=>[key,key==='data'&&typeof value==='string'&&['audio','image','video','document'].includes(v.type)?'[REVIEWED_MEDIA_SHA256:'+createHash('sha256').update(Buffer.from(value,'base64')).digest('hex')+']':auditCopy(value)])):v;
 const auditPayload=auditCopy(safe),serialized=JSON.stringify(auditPayload);
 if(Buffer.byteLength(serialized)>2_000_000)throw new AiPrivacyError();
 await privacyOperation(()=>config.audit({id:randomUUID(),scopeHash:createHmac('sha256',config.secret).update(scope).digest('hex'),provider,model,payload:auditPayload,payloadHash:createHash('sha256').update(serialized).digest('hex')}));
 return safe;
}
export async function assertAiMediaApproved(bytes:Uint8Array,mime:string){
 const config=configured();if(!config)return;
 const sha=createHash('sha256').update(bytes).digest('hex');
 if(!config.approvedMedia||!await privacyOperation(()=>config.approvedMedia!(sha,mime)))throw new AiPrivacyError();
}
// Only the new Telegram scope is affected; other existing channels retain their current transport.
export async function prepareTelegramTransportPayload<T>(body:T,model:string):Promise<T>{
 if(!scopes.getStore())return body;return prepareAiPayload(body,'gemini',model);
}
export async function assertTelegramTransportMedia(bytes:Uint8Array,mime:string){
 if(scopes.getStore())await assertAiMediaApproved(bytes,mime);
}

