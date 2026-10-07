import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../../evolution-api/package.json', import.meta.url));

for (const component of ['backend', 'evolution-api']) {
  test(`${component}: lock fija compression y proxy-addr corregidos`, () => {
    const lock = JSON.parse(readFileSync(new URL(`../../${component}/package-lock.json`, import.meta.url), 'utf8'));
    assert.equal(lock.packages['node_modules/compression'].version, '1.8.2');
    assert.equal(lock.packages['node_modules/proxy-addr'].version, '2.0.8');
  });
}

test('Evolution carga los paquetes HTTP corregidos y valida confianza IPv4/IPv6', () => {
  assert.equal(require('compression/package.json').version, '1.8.2');
  assert.equal(require('proxy-addr/package.json').version, '2.0.8');
  assert.equal(typeof require('compression')(), 'function');
  const trust = require('proxy-addr').compile(['127.0.0.1/8', '::1/128']);
  assert.equal(trust('127.0.0.1'), true);
  assert.equal(trust('::ffff:127.0.0.1'), true);
  assert.equal(trust('203.0.113.10'), false);
});

test('Baileys actualizado carga desde CommonJS y conserva generación de mensajes', async () => {
  const baileys = require('baileys');
  assert.equal(typeof baileys.default, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  const message = await baileys.generateWAMessageContent({text:'Mensaje QA sin envío'},{});
  assert.equal(message.extendedTextMessage.text,'Mensaje QA sin envío');
  const bytes = baileys.proto.Message.encode(message).finish();
  assert.equal(baileys.proto.Message.decode(bytes).extendedTextMessage.text,'Mensaje QA sin envío');
});

for (const modulePath of ['minio/dist/main/notification.js','minio/dist/esm/notification.mjs']) {
  test(`MinIO procesa notificaciones con el parser corregido: ${modulePath}`, async () => {
    const module = await import(new URL(modulePath.replace('minio/', ''), pathToFileURL(require.resolve('minio/package.json'))));
    const expected = {eventName:'s3:ObjectCreated:Put',s3:{object:{key:'qa.txt'}}};
    const poller = new module.NotificationPoller({makeRequestAsync:async()=>Readable.from([JSON.stringify({Records:[expected]})+'\n'])},'qa-bucket','','',[]);
    const received = once(poller,'notification',{signal:AbortSignal.timeout(3000)});
    poller.once('notification',()=>poller.stop());
    poller.start();
    assert.deepEqual((await received)[0],expected);
  });
}

test('SDK Chatwoot conserva autenticación y respuestas con Axios corregido', async () => {
  const server=createServer((request,response)=>{
    assert.equal(request.url,'/api/v1/profile');
    assert.equal(request.headers.api_access_token,'qa-token');
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({id:1,name:'QA'}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const {default:ChatwootClient,ChatwootAPI}=require('@figuro/chatwoot-sdk');
    const client=new ChatwootClient({config:{...ChatwootAPI,basePath:`http://127.0.0.1:${server.address().port}`,token:'qa-token',headers:{api_access_token:'qa-token'}}});
    assert.deepEqual(await client.profile.profile(),{id:1,name:'QA'});
  }finally{await new Promise((resolve)=>server.close(resolve));}
});

test('sharp procesa imágenes y cron conserva tareas programadas', async () => {
  const sharp=require('sharp');
  const buffer=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
  assert.equal((await sharp(buffer).metadata()).width,2);
  const cron=require('node-cron');
  assert.equal(cron.validate('*/5 * * * *'),true);
  const task=cron.schedule('0 0 * * *',()=>{});
  await task.stop();
  await task.destroy();
});

test('link-preview rechaza redes privadas sin abrir conexiones', async () => {
  const {getLinkPreview}=require('link-preview-js');
  for(const url of ['http://127.0.0.1/','http://[::1]/','http://169.254.169.254/']) {
    await assert.rejects(()=>getLinkPreview(url,{timeout:1000}));
  }
});
