import test,{after}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{createHash}from'node:crypto';
import{configureAiPrivacy}from'./telegram-ai-privacy.ts';import{runTelegramAgent}from'./telegram-context.ts';import{callGeminiWithPromptResult}from'./geminiService.ts';
const evidenceFixture='A. EVIDENCIA DEL PERIODO\n| Dato/Evento | Fragmento literal enmascarado | Estado |\n| --- | --- | --- |\n| Inicio | Sin evidencia explícita | No consta inicio / ejecución no confirmada |\n\nB. INFORMACIÓN PENDIENTE\nConfirmar el inicio.\n\nC. RECOMENDACIONES\nSolicitar confirmación.';
const cases=JSON.parse(fs.readFileSync(new URL('./telegram-privacy-corpus.json',import.meta.url),'utf8')).filter((c:any)=>typeof c.text==='string'),results:any[]=[];
const originalFetch=globalThis.fetch,originalKey=process.env.GOOGLE_GEMINI_API_KEY;process.env.GOOGLE_GEMINI_API_KEY='synthetic-local-only-key';let intercepted=0;
for(const c of cases)test('transport '+c.id+' '+c.category,async()=>{
 const audits:any[]=[],bodies:any[]=[];
 configureAiPrivacy({enabled:()=>true,secret:'synthetic-local-corpus-secret-only-20261113',loadPeople:async()=>[{id:'synthetic-client',name:'María Ejemplo',aliases:['María']}],audit:async r=>{audits.push(r);}});
 globalThis.fetch=async(_url,init)=>{intercepted++;bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output_text:evidenceFixture}),{status:200,headers:{'content-type':'application/json'}});};
 let blocked=false;try{await runTelegramAgent({chatId:'telegram:synthetic-corpus-20261113',messages:[{timestamp:'2026-11-13T12:00:00Z',remitente:'Equipo LYN',texto:c.text,tipo:'text',autor_tipo:'equipo',empleado_id:'synthetic-employee'}],specialist:{id:'general',modelo:'flash',system_prompt:'Usa solo hechos de la conversación.'},callAgent:(prompt,model,system)=>callGeminiWithPromptResult(prompt,model,system)});}catch{blocked=true;}
 const body=bodies.at(-1),serialized=JSON.stringify(body),leaks=body?(c.forbidden||[]).filter((s:string)=>serialized.includes(s.normalize('NFKC'))):[];
 const preserved=body?c.preserveExact?serialized.includes(c.text):(c.preserve||[]).every((s:string)=>serialized.includes(s)):false;
 const audit=audits.filter(a=>a.provider==='gemini').at(-1),auditMatches=!body||!!audit&&JSON.stringify(audit.payload)===JSON.stringify(body)&&audit.payloadHash===createHash('sha256').update(serialized).digest('hex');
 const passed=c.preserveExact?!blocked&&preserved:!leaks.length&&(blocked||preserved)&&auditMatches;
 results.push({id:c.id,category:c.category,passed,blocked,leakedSyntheticValues:leaks,meaningPreserved:preserved,exactFinalAuditMatches:auditMatches,mockedHttpRequests:bodies.length,finalMockedPayload:body});
 assert.ok(passed,JSON.stringify({id:c.id,leaks,blocked,preserved,auditMatches}));
});
test('final transport audit failure blocks dispatch even after the preparatory audit succeeds',async()=>{
 let requests=0,preparatory=0;globalThis.fetch=async()=>{requests++;throw Error('must_not_dispatch');};
 configureAiPrivacy({enabled:()=>true,secret:'synthetic-local-corpus-secret-only-20261113',loadPeople:async()=>[],audit:async r=>{if(r.provider==='gemini')throw Error('synthetic_final_audit_failure');preparatory++;}});
 await assert.rejects(runTelegramAgent({chatId:'telegram:synthetic-final-audit',messages:[{timestamp:'2026-11-13T12:00:00Z',remitente:'Equipo LYN',texto:'Entrega pendiente del permiso.'}],specialist:{id:'general',modelo:'flash',system_prompt:'Solo hechos.'},callAgent:(p,m,s)=>callGeminiWithPromptResult(p,m,s)}));
 assert.equal(requests,0);assert.equal(preparatory,1);
 results.push({id:'G01',category:'auditoria_final',passed:true,mockedHttpRequests:0,preparatoryAudits:preparatory});
});
after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.GOOGLE_GEMINI_API_KEY;else process.env.GOOGLE_GEMINI_API_KEY=originalKey;});
