import test,{after} from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{createHash}from'node:crypto';
import{configureAiPrivacy,prepareAiPayload,withAiPrivacyScope}from'./telegram-ai-privacy.ts';
const cases=JSON.parse(fs.readFileSync(new URL('./telegram-privacy-corpus.json',import.meta.url),'utf8'));
const results:any[]=[],audits:any[]=[];let networkAttempts=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{networkAttempts++;throw Error('external_network_forbidden_in_local_corpus');};
configureAiPrivacy({enabled:()=>true,secret:'synthetic-local-corpus-secret-only-20261113',loadPeople:async()=>[{id:'synthetic-client',name:'María Ejemplo',aliases:['María']}],audit:async r=>{audits.push(r);}});
for(const c of cases)test(c.id+' '+c.category,async()=>{
 const input=c.payload||{text:c.text};let safe:any,blocked=false;try{safe=await withAiPrivacyScope('telegram:synthetic-corpus-20261113',()=>prepareAiPayload(input,'local-fixture','local-fixture'));}catch{blocked=true;}
 const serialized=JSON.stringify(safe),leaks=blocked?[]:(c.forbidden||[]).filter((s:string)=>serialized.includes(s.normalize('NFKC')));
 const preserved=blocked?false:c.preserveExact?safe.text===c.text:(c.preserve||[]).every((s:string)=>serialized.includes(s));
 const audit=audits.at(-1),auditMatches=blocked||!!audit&&audit.payloadHash===createHash('sha256').update(JSON.stringify(safe)).digest('hex');
 const passed=c.preserveExact?!blocked&&preserved:!leaks.length&&(blocked||preserved)&&auditMatches;
 results.push({id:c.id,category:c.category,passed,blocked,leakedSyntheticValues:leaks,meaningPreserved:preserved,auditMatches,maskedPayload:safe});
 assert.ok(passed,JSON.stringify({id:c.id,leaks,blocked,preserved,auditMatches}));
});
after(()=>{assert.equal(networkAttempts,0);globalThis.fetch=originalFetch;});
