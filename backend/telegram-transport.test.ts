import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {configureAiPrivacy,withAiPrivacyScope} from './telegram-ai-privacy.ts';import {callGeminiWithPromptResult,callGeminiWithMediaResult} from './geminiService.ts';
test('real Gemini transport audits exactly its masked HTTP body only in Telegram scope',async()=>{
 const previous=globalThis.fetch,old=process.env.GOOGLE_GEMINI_API_KEY;process.env.GOOGLE_GEMINI_API_KEY='synthetic-fixture-key';const audits:any[]=[],bodies:any[]=[];
 configureAiPrivacy({enabled:()=>true,secret:'fixture-privacy-secret-long-enough-for-hmac',loadPeople:async()=>[{id:'fixture',name:'Cliente Sintetico'}],audit:async r=>{audits.push(r);}});
 globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output_text:'Respuesta sintética sin datos personales'}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const result=await withAiPrivacyScope('telegram:fixture',()=>callGeminiWithPromptResult('Cliente Sintetico; correo prueba@example.com; candado 8472','flash','Atiende a Cliente Sintetico'));
  assert.equal(result.fallback,false);assert.equal(audits.length,1);assert.deepEqual(audits[0].payload,bodies[0]);assert.equal(audits[0].payloadHash,createHash('sha256').update(JSON.stringify(bodies[0])).digest('hex'));
  for(const raw of ['Cliente Sintetico','prueba@example.com','8472'])assert.ok(!JSON.stringify(bodies[0]).includes(raw));
  await callGeminiWithPromptResult('Contenido legado sintético','flash');assert.equal(audits.length,1);assert.equal(bodies.length,2);
  await assert.rejects(withAiPrivacyScope('telegram:fixture',()=>callGeminiWithMediaResult('Prueba',[{type:'audio',base64:Buffer.from('fixture').toString('base64'),mimeType:'audio/ogg'}])));assert.equal(bodies.length,2);
 }finally{globalThis.fetch=previous;if(old===undefined)delete process.env.GOOGLE_GEMINI_API_KEY;else process.env.GOOGLE_GEMINI_API_KEY=old;}
});
