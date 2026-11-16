import test from 'node:test';import assert from 'node:assert/strict';
import {configureAiPrivacy,prepareAiPayload,withAiPrivacyScope} from './telegram-ai-privacy.ts';import {runTelegramAgent} from './telegram-context.ts';
const audits:any[]=[];const configure=(audit:any=async(r:any)=>audits.push(r))=>configureAiPrivacy({enabled:()=>true,secret:'synthetic-qa-secret-never-a-real-secret-12345',loadPeople:async()=>[{id:'fixture-client',name:'Persona Ficticia',aliases:['Persona']}],audit});
test('Telegram agent sees masked names, email, phone, DNI, IBAN, address and access PIN; egress audit matches',async()=>{
 configure();let sent='';const result=await runTelegramAgent({chatId:'telegram:fixture',messages:[{timestamp:'2026-11-12T12:00:00Z',remitente:'Persona Ficticia',texto:'Persona Ficticia. Email: prueba@example.com; +34 612 345 678; DNI 12345678Z; ES91 2100 0418 4502 0005 1332; calle Mayor 12; candado: 8472'}],specialist:{id:'general',modelo:'flash',system_prompt:'Usa evidencia'},callAgent:async(prompt)=>{sent=prompt;return{text:'Resumen de prueba',provider:'gemini',model:'fixture-model',fallback:false};}});
 assert.equal(result.source,'Telegram');for(const raw of ['Persona Ficticia','prueba@example.com','612 345 678','12345678Z','2100 0418','Mayor 12','8472'])assert.ok(!sent.includes(raw),raw);assert.equal(audits.at(-1).payload.prompt,sent);
});
test('analysis includes text older than the display page and media metadata without inventing its contents',async()=>{
 configure();let sent='';const result=await runTelegramAgent({chatId:'fixture',messages:[{timestamp:Date.now(),remitente:'Equipo',texto:'Acuerdo antiguo del inicio',tipo:'text'},{timestamp:Date.now(),remitente:'Equipo',texto:'',tipo:'document',media:{state:'stored',telegram_file_id:'must-not-reach-ai',storage_sha256:'must-not-reach-ai'}}],specialist:{modelo:'flash',system_prompt:'Solo hechos'},callAgent:async prompt=>{sent=prompt;return{text:'Resultado sintético',provider:'gemini',model:'fixture',fallback:false};}});assert.equal(result.source,'Telegram');assert.match(sent,/Acuerdo antiguo del inicio/);assert.match(sent,/Adjunto document; estado stored; contenido binario no interpretado/);assert.ok(!sent.includes('must-not-reach-ai'));
});
test('same person keeps one marker in a conversation and changes in another; audit failure blocks agent',async()=>{
 configure();const one=()=>prepareAiPayload({text:'Persona Ficticia'},'gemini','fixture');const a=await withAiPrivacyScope('conversation-a',one),b=await withAiPrivacyScope('conversation-a',one),c=await withAiPrivacyScope('conversation-b',one);assert.deepEqual(a,b);assert.notDeepEqual(a,c);
 configure(async()=>{throw Error('audit down');});let calls=0;await assert.rejects(runTelegramAgent({chatId:'fixture',messages:[{timestamp:Date.now(),remitente:'Persona Ficticia',texto:'hola'}],specialist:{modelo:'flash',system_prompt:'test'},callAgent:async()=>{calls++;throw Error();}}));assert.equal(calls,0);
});
test('unreviewed binaries are blocked and a local fallback cannot pass as a successful agent run',async()=>{
 configure();await assert.rejects(prepareAiPayload({type:'audio',mime_type:'audio/ogg',data:Buffer.from('synthetic').toString('base64')},'gemini','fixture'));
 await assert.rejects(runTelegramAgent({chatId:'fixture',messages:[{timestamp:Date.now(),remitente:'Equipo',texto:'Prueba sin datos personales'}],specialist:{modelo:'flash',system_prompt:'test'},callAgent:async()=>({text:'simulado',provider:'local-fallback',model:'local',fallback:true})}));
});
