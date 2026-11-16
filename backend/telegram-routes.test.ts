import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {registerTelegramContextRoutes} from './telegram-context.ts';
test('context routes require admin, use existing masked agent and reject an invalid attachment reference',async()=>{
 const app=express();app.use(express.json());let queries=0,agents=0,audits=0,runs=0;
 const message={id:'fixture',chat_id:'telegram:fixture',proyecto_id:'synthetic-project',remitente:'Persona Ficticia',timestamp:new Date(),texto:'Persona Ficticia; prueba@example.com; candado 8472',media:{storage_sha256:'../../etc/passwd'}};
 registerTelegramContextRoutes(app,{privacyKey:'synthetic-fixture-privacy-key-long-enough-12345',admin:(req,res,next)=>{if(req.headers.authorization!=='Bearer synthetic-admin'){res.status(403).end();return;}next();},pool:{query:async(sql)=>{queries++;if(sql.startsWith('select id from especialistas'))return{rows:[{id:'general'}]};if(sql.startsWith('select id,nombre'))return{rows:[{id:'fixture',nombre:'Persona',apellido:'Ficticia'}]};if(sql.startsWith('insert into telegram_ai_egress'))audits++;if(sql.startsWith('insert into telegram_agent_runs'))runs++;return{rows:[message]};}},resolveSpecialist:id=>id==='general'?{id,modelo:'flash',system_prompt:'Solo hechos'}:undefined,callAgent:async p=>{agents++;for(const raw of ['Persona Ficticia','prueba@example.com','8472'])assert.ok(!p.includes(raw));return{text:'Resumen sintético',provider:'gemini',model:'fixture',fallback:false};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  assert.equal((await fetch(base+'/api/telegram/context/conversations')).status,403);assert.equal(queries,0);
  const response=await fetch(base+'/api/telegram/context/analyze',{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({chatId:'telegram:fixture',specialistId:'general'})});assert.equal(response.status,200);assert.equal((await response.json()).source,'Telegram');assert.equal(agents,1);assert.equal(audits,1);assert.equal(runs,1);
  assert.equal((await fetch(base+'/api/telegram/context/attachment/fixture',{headers:{authorization:'Bearer synthetic-admin'}})).status,404);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('long conversations are paginated without silent truncation and oversized analysis is not sent',async()=>{
 const app=express();app.use(express.json());let agents=0,limit=0;const all=Array.from({length:1001},(_,i)=>({id:'fixture-'+i,chat_id:'telegram:fixture',proyecto_id:'work',remitente:'Equipo',timestamp:new Date(1794480000000+i*1000),texto:'Mensaje sintético',tipo:'text'}));
 registerTelegramContextRoutes(app,{privacyKey:'synthetic-fixture-privacy-key-long-enough-12345',admin:(_req,_res,next)=>next(),pool:{query:async(sql,args)=>{if(sql.startsWith('select id from especialistas'))return{rows:[{id:'general'}]};if(sql.includes('from mensajes m')){assert.ok(sql.includes('p.activo'));limit=Number(args?.[1]);return{rows:all.slice(-limit).reverse()};}return{rows:[]};}},resolveSpecialist:()=>({id:'general',modelo:'flash'}),callAgent:async()=>{agents++;throw Error('must not run');}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as any).port;
 try{const page=await (await fetch(base+'/api/telegram/context/messages?chatId=telegram%3Afixture')).json();assert.equal(page.messages.length,100);assert.equal(page.hasMore,true);assert.ok(page.nextCursor);assert.equal(limit,101);
 assert.equal((await fetch(base+'/api/telegram/context/messages?chatId=fixture&before=invalid')).status,400);
 const r=await fetch(base+'/api/telegram/context/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:'telegram:fixture'})});assert.equal(r.status,422);assert.equal((await r.json()).error,'telegram_context_too_large');assert.equal(agents,0);assert.equal(limit,1001);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('date bounds are shared by preview and analysis; invalid ranges cannot reach data or the agent',async()=>{
 const app=express();app.use(express.json());const params:any[]=[],message={id:'fixture',proyecto_id:'work',remitente:'Equipo',timestamp:new Date(),texto:'Mensaje de prueba',tipo:'text'};let calls=0,savedContext:any;
 registerTelegramContextRoutes(app,{privacyKey:'synthetic-fixture-privacy-key-long-enough-12345',admin:(_req,_res,next)=>next(),pool:{query:async(sql,args)=>{if(sql.includes('from mensajes m')){params.push(args);return{rows:[message]};}if(sql.includes('from especialistas'))return{rows:[{id:'general',nombre:'Agente actual'},{id:'inactive-cache',nombre:'No disponible'}]};if(sql.startsWith('insert into telegram_agent_runs'))savedContext=JSON.parse(String(args?.[8]));return{rows:[]};}},resolveSpecialist:id=>id==='general'?{id,modelo:'flash',system_prompt:'Solo hechos'}:undefined,callAgent:async()=>{calls++;return{text:'Resumen ficticio',provider:'gemini',model:'fixture',fallback:false};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as any).port,from='2026-11-01T00:00:00.000Z',to='2026-11-12T23:00:00.000Z';
 try{const specialists=await(await fetch(base+'/api/telegram/context/specialists')).json();assert.deepEqual(specialists.specialists,[{id:'general',name:'Agente actual'}]);
 assert.equal((await fetch(base+'/api/telegram/context/messages?chatId=fixture&from=invalid')).status,400);assert.equal(params.length,0);
 assert.equal((await fetch(base+'/api/telegram/context/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:'fixture',from:to,to:from})})).status,400);assert.equal(calls,0);
 assert.equal((await fetch(base+'/api/telegram/context/messages?chatId=fixture&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to))).status,200);
 const r=await fetch(base+'/api/telegram/context/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:'fixture',from,to})});assert.equal(r.status,200);assert.deepEqual((await r.json()).period,{from,to});assert.equal(calls,1);assert.deepEqual(params.map(a=>a.slice(4)),[[from,to],[from,to]]);assert.deepEqual(savedContext,{from,to,messageCount:1,messageIds:['fixture']});
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
