import test,{after}from'node:test';
import assert from'node:assert/strict';
import{configureAiPrivacy}from'./telegram-ai-privacy.ts';
import{runTelegramAgent,TelegramEvidenceError}from'./telegram-context.ts';
import{callGeminiWithPromptResult}from'./geminiService.ts';
const originalFetch=globalThis.fetch,originalKey=process.env.GOOGLE_GEMINI_API_KEY;
process.env.GOOGLE_GEMINI_API_KEY='synthetic-transport-evidence-key';
const table=(row:string)=>'A. EVIDENCIA DEL PERIODO\n| dato/evento | fragmento literal enmascarado | estado |\n| --- | --- | --- |\n'+row+'\n\nB. INFORMACIÓN PENDIENTE\nSolicitar confirmaciones.\n\nC. RECOMENDACIONES\nComprobar si hay un acuerdo.';
const run=()=>runTelegramAgent({chatId:'telegram:synthetic-markdown-evidence',messages:[{timestamp:'2026-11-17T15:28:43Z',remitente:'Equipo',tipo:'text',texto:'se presupuestaron dos puertas blancas por 2400 EUR. Se han cobrado 1200 EUR. No se han aportado medidas de los huecos ni el archivo del plano.'}],specialist:{id:'director',modelo:'flash',system_prompt:'Usa evidencia del periodo.'},callAgent:(p,m,s)=>callGeminiWithPromptResult(p,m,s)});
function configure(audits:any[]){configureAiPrivacy({enabled:()=>true,secret:'synthetic-local-markdown-evidence-secret',loadPeople:async()=>[],audit:async r=>{audits.push(r);}});}

test('the actual Gemini transport preserves inline-code citation content before the evidence guard',async()=>{
 const audits:any[]=[],bodies:any[]=[];configure(audits);
 const raw=table('| presupuesto | `se presupuestaron dos puertas blancas por 2400 EUR` | Presupuestado |\n| cobro | `Se han cobrado 1200 EUR` | Declarado |\n| inicio | Sin evidencia explícita | No consta inicio |');
 globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output_text:raw}),{status:200});};
 const result=await run();
 assert.equal(bodies.length,1);assert.equal(result.provider,'gemini');assert.equal(result.fallback,false);
 assert.equal(result.evidenceValidation.verifiedQuotes,2);
 assert.ok(result.originalText.includes('| presupuesto | se presupuestaron dos puertas blancas por 2400 EUR |'));
 assert.ok(!result.text.includes('| presupuesto |  |'));
 assert.ok(result.text.includes('conclusión, no cita literal'));
 assert.deepEqual(audits.filter(a=>a.provider==='gemini').at(-1).payload,bodies[0]);
});

test('preserving Markdown text does not accept empty citations or misclassify missing-plan evidence as an attachment',async()=>{
 configure([]);let requests=0;
 for(const row of ['| presupuesto |  | Presupuestado |','| adjunto | `No se han aportado medidas de los huecos ni el archivo del plano` | Archivo no aportado |']){
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({output_text:table(row)}),{status:200});};
  await assert.rejects(run(),TelegramEvidenceError);
 }
 assert.equal(requests,2);
});
after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.GOOGLE_GEMINI_API_KEY;else process.env.GOOGLE_GEMINI_API_KEY=originalKey;configureAiPrivacy(undefined);});
