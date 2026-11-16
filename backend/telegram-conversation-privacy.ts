import {createHash,createHmac} from 'node:crypto';
export type PrivacyPerson={id:string;name:string;aliases?:string[]};
export type ProtocolPrivacyContext = { clientNames?: string[]; nameMarkers?: Readonly<Record<string,string>> };
const foldName=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/gu,' ').trim();
const shortWords=new Set(['de','la','el','un','en','es','se','al','mi','su','no','si','tu','yo']);
const usableName=(name:string)=>name.length>=2&&!shortWords.has(name);
// Stable pseudonyms use server-side directory IDs, never hashes of names or phones.
export function createConversationPrivacy(scopeId:string,people:PrivacyPerson[],secret=process.env.AI_PRIVACY_HMAC_KEY||''):ProtocolPrivacyContext{
 if(!scopeId||scopeId.length>200)throw Error('privacy-scope-required');
 const markers:Record<string,string>={};const owners=new Map<string,Set<string>>();
 for(const p of people){if(!p.id||!p.name.trim())continue;for(const alias of [p.name,...p.aliases||[]]){const key=foldName(alias);if(!usableName(key))continue;const set=owners.get(key)||new Set<string>();set.add(p.id);owners.set(key,set);}}
 for(const p of people){if(!p.id||!p.name.trim())continue;const marker='[PERSONA:'+(secret.length>=32?createHmac('sha256',secret):createHash('sha256')).update(scopeId+'\0'+p.id).digest('hex').slice(0,16)+']';for(const alias of [p.name,...p.aliases||[]]){const key=foldName(alias);if(owners.get(key)?.size===1)markers[key]=marker;}}
 return{clientNames:[...owners.keys()],nameMarkers:markers};
}

const personalPatterns: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])/giu, '[EMAIL]'],
  // Recognize common fixed-length IBANs before the generic international form.
  // This is redaction, not validation of an account or its check digits.
  [/\bES\d{2}(?:[\s-]*\d){20}\b|\bGB\d{2}(?:[\s-]*[A-Z]){4}(?:[\s-]*\d){14}\b/giu,'[IBAN]'],
  [/\b[A-Z]{2}\d{2}(?:[\s-]*[A-Z0-9]{4}){3,7}(?:[\s-]*[A-Z0-9]{1,3})?\b/giu, '[IBAN]'],
  [/\b(?:DNI|NIF)\s*[:=]?\s*(?:\d[ .-]?){8}[A-Z]\b|\b(?:\d{8}|\d{2}[ .-]\d{3}[ .-]\d{3})[ -]?[A-Z]\b|\b[XYZ][ .-]?(?:\d[ .-]?){7}[A-Z]\b/giu, '[DNI]'],
  [/\b(?:tel[eé]fono|m[oó]vil|whatsapp|tlf|celular)\s*(?:es\s*)?[:=]?\s*\+?\(?\d(?:[\s().-]{0,3}\d){6,14}\)?(?!\w)/giu, '[TELÉFONO]'],
  [/(?<!\w)(?:\+|00)\d{1,3}(?:[\s().-]?\d){7,14}(?!\w)|(?<!\w)[679](?:[\s.-]?\d){8}(?!\w)|(?<![\w])\d{7,15}(?!\w)/gu, '[TELÉFONO]'],
  [/(?<!\w)(?=(?:[ .()-]*\d){9})\(?\d{2,4}\)?(?:[ .()-]+\d{2,4}){2,4}(?!\w)/gu,'[TELÉFONO]'],
  [/(?<!\w)\d{3}[ .-]\d{4}(?!\w)/gu,'[TELÉFONO]'],
  [/\b(?:direcci[oó]n|domicilio)(?:\s+(?:es\s+)?|[ \t]*[:=][ \t]*)[^\n;!?¿¡]{3,180}/giu, '[DIRECCIÓN]'],
  [/\b(?:(?:calle|callej[oó]n|avenida|paseo|plaza|carretera|camino|urbanizaci[oó]n)\s+|(?:avda|av|pl|c)\.\s*|c\s*\/\s*)[^\n;!?¿¡]{3,180}/giu, '[DIRECCIÓN]'],
];

export function normalizePrivacyText(value:string):string{
 return value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/\p{Nd}/gu,digit=>{
  const cp=digit.codePointAt(0)!;if(cp>=48&&cp<=57)return digit;
  let first=cp;while(first>0&&/\p{Nd}/u.test(String.fromCodePoint(first-1)))first--;
  return String((cp-first)%10);
 });
}

export function isPersonalDataField(key:string):boolean{
 const normalized=normalizePrivacyText(key).toLowerCase().replace(/[\s_-]/gu,'');
 return /^(?:phone|phonenumber|telefono|teléfono|email|dni|nie|iban|direccion|dirección|address|nombre|fullname|firstname|lastname|accesscode|password|contraseña|contrasena|token|accesstoken)$/u.test(normalized);
}

function businessNumber(text:string,offset:number,value:string):boolean{
 // Explicit phone labels are processed first. A '+' or international '00'
 // never becomes a public business reference merely because of a nearby label.
 if(!/^\d[\d., ]*$/u.test(value)||value.startsWith('00'))return false;
 const before=text.slice(Math.max(0,offset-70),offset),after=text.slice(offset+value.length);
 if(before.lastIndexOf('[')>before.lastIndexOf(']'))return false;
 return /^\s*(?:EUR|USD|euros?|d[oó]lares?)(?!\p{L})/iu.test(after)||/^\s*[€$]/u.test(after)
  ||/[€$]\s*$/u.test(before)
  ||/\b(?:factura|presupuesto|albar[aá]n|pedido|referencia)\s*(?:(?:n[úu]mero|n[.º°]|#|:)\s*)?$/iu.test(before);
}

function maskAccessCodes(text:string):string{
 const pattern=/\b(candado|pin|contrase[nñ]a|clave|c[oó]digo)\b(\s+(?:(?:de|del|para)(?:\s+(?:la|el))?\s+)?(?:acceso|candado|entrada|portal|puerta|entrar|garaje|cerradura|wifi|wi-fi))?\s*[:#=]?\s*(?:(?:es|era|ser[aá]|actual|nuevo|se\s+abre\s+con)\s*[:#=]?\s*)?(\d(?:[ -]?\d){2,11}(?![\p{L}\p{N}])|"[^"\n]{3,80}"|'[^'\n]{3,80}'|[^\s;,]{3,80})/giu;
 return text.replace(pattern,(whole,label,qualifier,value,offset)=>{
  if(/^(?:de|del|para|es|era|actual|nuevo)$/iu.test(value))return whole;
  if(/^c[oó]digo$/iu.test(label)&&!qualifier&&/^[A-Z]{1,6}-\d+(?:[.-]\d+)*[.!?]?$/iu.test(value)){
   const before=text.slice(Math.max(0,offset-70),offset),after=text.slice(offset+whole.length);
   if(/\b(?:plano|documento|factura|pedido|referencia)[\s,:]*$/iu.test(before)
    ||/^\s*[;,.-]?\s*(?:es\s+)?(?:una?\s+)?referencia\s+(?:de|del)\s+(?:plano|documento|factura|pedido)\b/iu.test(after))return whole;
  }
  return '[CÓDIGO_ACCESO]';
 }).replace(/\b(?:pin|candado)\d{3,12}\b/giu,'[CÓDIGO_ACCESO]');
}

function maskPlainPatterns(text:string):string{
 let masked=maskAccessCodes(text);
 for(const[pattern,marker]of personalPatterns){const source=masked;masked=source.replace(pattern,(value,...args)=>{
  if(marker==='[TELÉFONO]'&&businessNumber(source,args[args.length-2],value))return value;
  if(marker==='[DIRECCIÓN]'&&/^direcci[oó]n\s+(?:confirma|aprueba|autoriza|solicita|informa|rechaza|revisa|valida)\b/iu.test(value))return value;
  return marker;
 });}
 return masked;
}

function maskPersonalPatterns(text:string):string{
 const links=text.replace(/\bhttps?:\/\/[^\s<>"']+/giu,raw=>{
  let decoded=raw;for(let i=0;i<3;i++){try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{break;}}
  try{const url=new URL(decoded);if(url.username||url.password||[...url.searchParams.keys()].some(isPersonalDataField))return '[ENLACE_PRIVADO]';}catch{/* Recognize plain identifiers even when the URL is malformed. */}
  return maskPlainPatterns(normalizePrivacyText(decoded))!==normalizePrivacyText(decoded)?'[ENLACE_PRIVADO]':raw;
 });
 return maskPlainPatterns(links);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskProtocolQuestion(question: string, context: ProtocolPrivacyContext = {}): string {
 let masked=normalizePrivacyText(question);
 // Recognize complete mailboxes/identifiers before substituting names inside them.
 masked=maskPersonalPatterns(masked);
 const accents:Record<string,string>={a:'[aáàäâãå]',e:'[eéèëê]',i:'[iíìïî]',o:'[oóòöôõ]',u:'[uúùüû]',n:'[nñ]',c:'[cç]'};
 const names=[...new Set(context.clientNames||[])].filter(name=>usableName(foldName(name))).sort((a,b)=>b.length-a.length);
 for(const name of names){
  const key=foldName(name),pattern=[...key].map(c=>c===' '?'\\s+':accents[c]||escapePattern(c)).join('');
  masked=masked.replace(new RegExp('(?<![\\p{L}])'+pattern+'(?![\\p{L}])','giu'),()=>context.nameMarkers?.[key]||'[NOMBRE]');
 }
 return masked;
}

export function containsUnmaskedPersonalData(text: string): boolean {
  // Generated pseudonyms can contain digit runs; they are not telephone numbers.
  const remaining=normalizePrivacyText(text).replace(/\[PERSONA:[a-f0-9]{16}\]/gu,'');
  return maskPersonalPatterns(remaining)!==remaining;
}

export function canReadProtocolLog(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return ['superadmin', 'admin', 'employee:director', 'employee:director_general', 'employee:director_de_operaciones', 'employee:direccion_de_operaciones'].includes(normalized);
}

export async function hasClubAdminRole(
  query: (sql: string, params: [number]) => Promise<{ rows: Array<{ allowed: boolean }> }>,
  sessionId: number | undefined,
): Promise<boolean> {
  if (!Number.isSafeInteger(sessionId) || !sessionId || sessionId <= 0) return false;
  const result = await query(`
    SELECT EXISTS (
      SELECT 1 FROM usuarios account
      JOIN LATERAL (
        SELECT id FROM empleados
        WHERE LOWER(email) = LOWER(account.email) AND activo = TRUE
        ORDER BY id LIMIT 1
      ) employee ON TRUE
      JOIN usuario_rol assignment ON assignment.empleado_id = employee.id
      WHERE account.id = $1 AND account.auth_provider = 'supabase' AND account.activo = TRUE
        AND assignment.rol_id IN ('admin', 'superadmin')
    ) AS allowed`, [sessionId]);
  return result.rows[0]?.allowed === true;
}

export function canReadProtocolReport(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toLowerCase().replace(/[\s/-]+/gu, '_');
  return canReadProtocolLog(role) || normalized === 'employee:gerente_tecnico';
}
