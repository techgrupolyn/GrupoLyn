import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(new URL('../../evolution-api/package.json', import.meta.url));
const source = await readFile(new URL('../../evolution-api/src/utils/history-recovery.ts', import.meta.url), 'utf8');
const compiled = require('esbuild').transformSync(source, { loader: 'ts', format: 'esm' }).code;
const { createHistoryRecovery } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const remoteJid = '120363000000001@g.us';
const anchor = { key: { id: 'oldest', remoteJid, fromMe: false }, messageTimestamp: 1790000000 };

test('usa 50 por solicitud, convierte segundos a ms y no repite solicitudes concurrentes', async () => {
  let calls = 0;
  const recover = createHistoryRecovery({
    connected: () => true, enabled: () => true, oldest: async () => anchor,
    request: async (count, key, stamp) => {
      calls++;
      assert.equal(count, 50);
      assert.deepEqual(key, anchor.key);
      assert.equal(stamp, 1790000000000);
      return 'request-1';
    },
  });
  const results = await Promise.all([recover(remoteJid), recover(remoteJid)]);
  assert.deepEqual(results, [{ status: 'requested', requestId: 'request-1' }, { status: 'requested', requestId: 'request-1' }]);
  assert.equal((await recover(remoteJid)).status, 'waiting');
  assert.equal(calls, 1);
});

test('un acuse no significa entrega; detecta ausencia de progreso y permite reintento posterior', async () => {
  let time = 0;
  let calls = 0;
  const recover = createHistoryRecovery({ connected: () => true, enabled: () => true, oldest: async () => anchor,
    request: async () => `req-${++calls}`, now: () => time });
  await recover(remoteJid);
  time = 119999;
  assert.equal((await recover(remoteJid)).status, 'waiting');
  time = 120000;
  assert.equal((await recover(remoteJid)).status, 'no_progress');
  time = 600000;
  assert.equal((await recover(remoteJid)).status, 'requested');
  assert.equal(calls, 2);
});

test('recorre referencias nuevas sin tope total de mensajes y aísla instancias', async () => {
  let position = 0;
  const calls = [];
  const dependencies = { connected: () => true, enabled: () => true,
    oldest: async () => ({ ...anchor, key: { ...anchor.key, id: `position-${position}` } }),
    request: async (count, key) => { calls.push(key.id); return key.id; } };
  const first = createHistoryRecovery(dependencies);
  const second = createHistoryRecovery(dependencies);
  for (position = 0; position < 401; position++) assert.equal((await first(remoteJid)).status, 'requested');
  position = 400;
  assert.equal((await first(remoteJid)).status, 'waiting');
  assert.equal((await second(remoteJid)).status, 'requested');
  assert.equal(calls.length, 402);
});

test('no fabrica referencias, no cruza grupos y no solicita nada sin conexión o persistencia', async () => {
  const request = async () => { throw new Error('Unexpected request'); };
  for (const [connected, enabled, oldest, status] of [
    [false, true, anchor, 'disconnected'], [true, false, anchor, 'disabled'],
    [true, true, null, 'no_anchor'], [true, true, { ...anchor, key: { ...anchor.key, remoteJid: 'other@g.us' } }, 'no_anchor'],
    [true, true, { ...anchor, messageTimestamp: 0 }, 'no_anchor'],
  ]) {
    const recover = createHistoryRecovery({ connected: () => connected, enabled: () => enabled, oldest: async () => oldest, request });
    assert.equal((await recover(remoteJid)).status, status);
    await assert.rejects(recover('123@s.whatsapp.net'), /Invalid group/);
  }
});

test('conserva milisegundos y normaliza el JID alternativo comprobado', async () => {
  const recover = createHistoryRecovery({ connected: () => true, enabled: () => true,
    oldest: async () => ({ key: { id: 'alt', remoteJid: 'other@g.us', remoteJidAlt: remoteJid, fromMe: true }, messageTimestamp: 1790000000000 }),
    request: async (count, key, stamp) => { assert.equal(key.remoteJid, remoteJid); assert.equal(stamp, 1790000000000); return 'ok'; } });
  assert.equal((await recover(remoteJid)).status, 'requested');
});

test('un fallo de transporte libera el bloqueo sin registrar un éxito', async () => {
  let calls = 0;
  const recover = createHistoryRecovery({ connected: () => true, enabled: () => true, oldest: async () => anchor,
    request: async () => { if (++calls === 1) throw new Error('network'); return 'ok'; } });
  await assert.rejects(recover(remoteJid), /network/);
  assert.equal((await recover(remoteJid)).status, 'requested');
});

test('la ruta conserva guards y toma la instancia de la URL, no de query o body', async () => {
  const router = await readFile(new URL('../../evolution-api/src/api/routes/chat.router.ts', import.meta.url), 'utf8');
  const service = await readFile(new URL('../../evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', import.meta.url), 'utf8');
  assert.match(router, /routerPath\('requestHistory'\), \.\.\.guards/);
  assert.match(router, /const instanceName = req\.params\.instanceName;\s*const response = await this\.dataValidate<RequestHistoryDto>/);
  assert.match(router, /chatController\.requestHistory\(\{ instanceName \}, data\)/);
  const recovery = service.slice(service.indexOf('private readonly recoverHistory'), service.indexOf('public async fetchMessages'));
  assert.match(recovery, /instanceId: this\.instanceId/);
  assert.doesNotMatch(recovery, /sendMessage|readMessages|logout|markMessageAsRead/);
  assert.doesNotMatch(service, /on-demand history sync, messages=/);
});

test('la validación rechaza identificadores, cursores e instancias arbitrarias del cliente', async () => {
  const schemaSource = await readFile(new URL('../../evolution-api/src/validate/chat.schema.ts', import.meta.url), 'utf8');
  const code = require('esbuild').transformSync(schemaSource, { loader: 'ts', format: 'cjs' }).code;
  const schemaModule = { exports: {} };
  vm.runInNewContext(code, { module: schemaModule, exports: schemaModule.exports, require });
  const { validate } = require('jsonschema');
  const schema = schemaModule.exports.requestHistorySchema;
  assert.equal(validate({ remoteJid }, schema).valid, true);
  for (const body of [{}, { remoteJid: '123@s.whatsapp.net' }, { remoteJid, instanceName: 'other' }, { remoteJid, oldestMsgId: 'invented' }, { remoteJid, count: 20000 }]) {
    assert.equal(validate(body, schema).valid, false);
  }
});
