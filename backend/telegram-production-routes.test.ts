import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {registerTelegramContextRoutes} from './telegram-context.ts';
test('backend production visibility and AI are separately authorized and revoked before model egress',async()=>{
 const previous=process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE;process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE='true';
 const app=express();app.use(express.json());let allowAi=false,models=0,audits=0;const queries:string[]=[];
 const message={id:'synthetic-real',chat_id:'telegram:fixture',proyecto_id:'fixture',production_group:true,remitente:'Equipo',timestamp:new Date(),texto:'Mensaje ficticio de prueba',tipo:'text'};
 const answer='A. EVIDENCIA DEL PERIODO\n| dato/evento | fragmento literal enmascarado | estado |\n| --- | --- | --- |\n| inicio | Sin evidencia explícita | No consta inicio |\n\nB. INFORMACIÓN PENDIENTE\nConfirmar inicio.\n\nC. RECOMENDACIONES\nSolicitar confirmación.';
 registerTelegramContextRoutes(app,{privacyKey:'synthetic-production-privacy-key-long-enough',admin:(_req,_res,next)=>next(),resolveSpecialist:()=>({id:'general',modelo:'fixture',system_prompt:'Solo hechos'}),
  pool:{query:async(sql)=>{queries.push(sql);if(sql.startsWith('select id from especialistas'))return{rows:[{id:'general'}]};if(sql.includes('bool_and('))return{rows:[{allowed:allowAi}]};if(sql.includes('from mensajes m'))return{rows:[message]};if(sql.startsWith('insert into telegram_ai_egress'))audits++;return{rows:[]};}},
  callAgent:async()=>{models++;return{text:answer,provider:'gemini',model:'fixture',fallback:false};}});
 if(previous===undefined)delete process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE;else process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE=previous;
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as any).port;
 const analyze=()=>fetch(url+'/api/telegram/context/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:'telegram:fixture'})});
 try{
  assert.equal((await fetch(url+'/api/telegram/context/messages?chatId=fixture')).status,200);
  assert.ok(queries.some(q=>q.includes("'context',m.timestamp")));
  const denied=await analyze();assert.equal(denied.status,403);assert.equal((await denied.json()).error,'telegram_production_ai_not_authorized');assert.equal(models,0);assert.equal(audits,0);
  allowAi=true;assert.equal((await analyze()).status,200);assert.equal(models,1);assert.ok(audits>=1);
  allowAi=false;assert.equal((await analyze()).status,403);assert.equal(models,1);
  await fetch(url+'/api/telegram/context/attachment/fixture');assert.ok(queries.some(q=>q.includes("'media',m.timestamp")));
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('the default backend keeps its test-only boundary and does not require production authorization tables',async()=>{
 const old=process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE;delete process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE;
 const app=express(),queries:string[]=[];registerTelegramContextRoutes(app,{privacyKey:'synthetic-production-privacy-key-long-enough',admin:(_req,_res,next)=>next(),resolveSpecialist:()=>null,pool:{query:async(sql)=>{queries.push(sql);return{rows:[]};}},callAgent:async()=>{throw Error('must not call model');}});
 if(old===undefined)delete process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE;else process.env.TELEGRAM_CONTEXT_PRODUCTION_ENABLE=old;
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const r=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/api/telegram/context/conversations');assert.equal(r.status,200);assert.equal((await r.json()).testOnly,true);assert.ok(queries.some(q=>q.includes('t.enabled and t.is_test')));assert.ok(!queries.some(q=>q.includes('telegram_central_scope_ready')));}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
