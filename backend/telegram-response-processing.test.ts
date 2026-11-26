import {test} from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {once} from 'node:events';
import {configureAiPrivacy} from './telegram-ai-privacy.ts';
import {processTelegramResponses,parseResponseOutput,registerTelegramResponseProcessing} from './telegram-response-processing.ts';
const group='a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12),row={id:'central:1',texto:'Necesito revisar las medidas. Cliente Persona Ficticia, prueba@example.com, teléfono +58 424 1112233',tipo:'text',autor_tipo:'cliente',telegram_message_id:1,telegram_update_id:7,timestamp:'2026-11-26T12:00:00Z',club_group_id:group};
const issue={messageId:'1',topic:'Medidas',priority:'pendiente',needsResponse:true,primaryRole:'interiorista',supportRoles:['pmc']};
function fixture(){const audits:any[]=[],calls:any[]=[];configureAiPrivacy({enabled:()=>true,secret:'synthetic-response-privacy-secret-long-enough',loadPeople:async()=>[{id:'fixture',name:'Persona Ficticia'}],audit:async a=>{audits.push(a);}});
 const deps={pool:{query:async(sql:string)=>sql.includes('from mensajes')?{rows:[row]}:{rows:[{id:'general'},{id:'interiorista'},{id:'director'}]}},resolveSpecialist:(id:string)=>['general','interiorista','director'].includes(id)?{id,modelo:'flash',system_prompt:'Usa solo hechos.'}:undefined,
 callAgent:async(prompt:string,model:any,system:string)=>{calls.push({prompt,system});return{text:JSON.stringify({issues:[issue]}),provider:'gemini',model:'synthetic',fallback:false};}};
 return{deps,audits,calls};
}
const request={mode:'classify',chatId:'telegram:44::-100123',groupId:group,messages:[{messageId:1,updateId:7}]};
test('classification reuses active specialists, masks full context and audits before calling model',async()=>{
 const f=fixture();const result:any=await processTelegramResponses(f.deps,request);assert.equal(result.issues[0].priority,'pendiente');assert.ok(result.issues[0].sourceExcerpt);
 assert.equal(f.calls.length,1);for(const raw of ['Persona Ficticia','prueba@example.com','424 1112233'])assert.ok(!f.calls[0].prompt.includes(raw));
 assert.ok(f.calls[0].system.includes('Nunca envíes'));assert.ok(f.audits.length>=2);
});
test('metadata contains only provenance and never invokes AI; stale references and disabled scopes fail closed',async()=>{
 const f=fixture();const result:any=await processTelegramResponses(f.deps,{...request,mode:'metadata',messages:[]});assert.equal(result.messages.length,1);assert.ok(!JSON.stringify(result).includes('texto'));assert.equal(f.calls.length,0);
 await assert.rejects(processTelegramResponses(f.deps,{...request,messages:[{messageId:1,updateId:6}]}),/context_changed/);
 await assert.rejects(processTelegramResponses({...f.deps,pool:{query:async()=>({rows:[]})}},request),/context_denied/);
});
test('authorized empty groups have an empty inbox; disabled targets remain denied',async()=>{
 const f=fixture();let allowed=true;
 const deps={...f.deps,pool:{query:async(sql:string)=>sql.includes('from mensajes')?{rows:[]}:{rows:[{allowed}]}}};
 const body={...request,mode:'metadata',messages:[]};
 assert.deepEqual(await processTelegramResponses(deps,body),{messages:[]});assert.equal(f.calls.length,0);
 allowed=false;await assert.rejects(processTelegramResponses(deps,body),/context_denied/);
});
test('strict output rejects missing IDs, invented roles, priority contradictions and non-JSON',()=>{
 for(const candidate of [{issues:[]},{issues:[{...issue,messageId:'2'}]},{issues:[{...issue,primaryRole:'CEO'}]},{issues:[{...issue,needsResponse:false}]},{issues:[issue,issue]}])assert.throws(()=>parseResponseOutput(JSON.stringify(candidate),'classify',['1']));
 assert.throws(()=>parseResponseOutput('no JSON','draft',['1']));assert.throws(()=>parseResponseOutput('{"text":""}','draft',['1']));
});
test('draft incorporates only configured primary/support roles and masks regeneration instruction',async()=>{
 const f=fixture();f.deps.callAgent=async(prompt,model,system)=>{f.calls.push({prompt,system});return{text:'{"text":"¿Puedes confirmar la medida del hueco?"}',provider:'gemini',model:'synthetic',fallback:false};};
 const result:any=await processTelegramResponses(f.deps,{...request,mode:'draft',primaryRole:'interiorista',supportRoles:['pmc'],instructions:'Más breve. Enviar a prueba@example.com'});
 assert.equal(result.text,'¿Puedes confirmar la medida del hueco?');assert.ok(!f.calls[0].prompt.includes('prueba@example.com'));assert.ok(f.calls[0].system.includes('Apoyo del especialista existente'));
 await assert.rejects(processTelegramResponses(f.deps,{...request,mode:'draft',primaryRole:'inventado',supportRoles:[]}),/invalid_response_request/);
});
test('fallback and privacy audit failures never become valid drafts',async()=>{
 const f=fixture();await assert.rejects(processTelegramResponses({...f.deps,callAgent:async()=>({text:'{"text":"Respuesta"}',provider:'local',model:'fixture',fallback:true})},{...request,mode:'draft',primaryRole:'interiorista',supportRoles:[]}),/not_executed/);
 configureAiPrivacy({enabled:()=>true,secret:'synthetic-response-privacy-secret-long-enough',loadPeople:async()=>[],audit:async()=>{throw Error('audit unavailable');}});
 await assert.rejects(processTelegramResponses(f.deps,request));assert.equal(f.calls.length,0);
});
test('server token required, no browser-origin requests and no cookie/session privilege bypass',async()=>{
 const f=fixture(),app=express();app.use(express.json());registerTelegramResponseProcessing(app,{...f.deps,token:async()=>'s'.repeat(50)});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port,url='http://127.0.0.1:'+port+'/api/telegram/response-processing';
 try{
  for(const headers of [{},{authorization:'Bearer wrong'},{authorization:'Bearer '+'s'.repeat(50),origin:'https://club-lyn.grupolyn.com'}]){const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(request)});assert.equal(res.status,403);}
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'s'.repeat(50)},body:JSON.stringify({...request,mode:'metadata',messages:[]})});assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

