import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(new URL('../../evolution-api/package.json', import.meta.url));
const source = await readFile(new URL('../../evolution-api/src/utils/webhook-batches.ts', import.meta.url), 'utf8');
const compiled = require('esbuild').transformSync(source, { loader: 'ts', format: 'esm' }).code;
const { splitWebhookBatches } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const historySource = await readFile(new URL('../../evolution-api/src/utils/history-chat.ts', import.meta.url), 'utf8');
const historyCode = require('esbuild').transformSync(historySource, { loader: 'ts', format: 'esm' }).code;
const { historyChat } = await import(`data:text/javascript;base64,${Buffer.from(historyCode).toString('base64')}`);
const controllerSource = await readFile(new URL('../../evolution-api/src/api/integrations/event/webhook/webhook.controller.ts', import.meta.url), 'utf8');
const controllerCode = require('esbuild').transformSync(controllerSource, { loader: 'ts', format: 'cjs' }).code;
const controllerModule = { exports: {} };
vm.runInNewContext(controllerCode, {
  module: controllerModule,
  exports: controllerModule.exports,
  Buffer,
  setTimeout,
  require: (name) => {
    if (name === '@utils/webhook-batches') return { splitWebhookBatches };
    if (name === '../event.controller') return { EventController: class {} };
    if (name === '@config/env.config') return { configService: { get: () => ({ RETRY: { MAX_ATTEMPTS: 2, INITIAL_DELAY_SECONDS: 0 } }) } };
    if (name === '@config/logger.config') return { Logger: class { log() {} error() {} } };
    if (name === 'axios' || name === 'jsonwebtoken') return {};
    throw new Error(`Unexpected dependency: ${name}`);
  },
});
const { WebhookController } = controllerModule.exports;

test('el historial conserva 39 pendientes, cero explícito y no inventa cero si falta el dato', () => {
  assert.deepEqual(historyChat({ id: 'qa@g.us', name: 'Grupo QA', unreadCount: 39 }, 'qa'), {
    remoteJid: 'qa@g.us', instanceId: 'qa', name: 'Grupo QA', unreadMessages: 39,
  });
  assert.equal(historyChat({ id: 'qa@g.us', unreadCount: 0 }, 'qa').unreadMessages, 0);
  assert.equal(Object.hasOwn(historyChat({ id: 'qa@g.us' }, 'qa'), 'unreadMessages'), false);
  assert.equal(Object.hasOwn(historyChat({ id: 'qa@g.us', unreadCount: null }, 'qa'), 'unreadMessages'), false);
});

test('divide más de 10 MB sin perder mensajes, orden ni instancia', () => {
  const messages = Array.from({ length: 1105 }, (unusedValue, index) => ({ id: index, text: 'á'.repeat(6000) }));
  const payload = { event: 'messages.set', instance: 'qa', data: messages, date_time: '2026-09-28' };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 10 * 1024 * 1024);
  const batches = splitWebhookBatches(payload);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap((batch) => batch.data), messages);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 512 * 1024);
    assert.equal(batch.instance, 'qa');
    assert.equal(batch.date_time, payload.date_time);
  }
});

test('conserva eventos pequeños, vacíos y no fragmentables', () => {
  for (const payload of [
    { event: 'connection.update', data: { state: 'open' } },
    { event: 'messages.set', data: [] },
    { event: 'messages.upsert', data: [{ id: 1 }] },
    { event: 'custom.event', data: [1, 2, 3] },
  ]) assert.deepEqual(splitWebhookBatches(payload), [payload]);
});

test('permite reducir lotes al recibir 413 y no descarta elementos individuales grandes', () => {
  const payload = { event: 'CHATS_SET', instance: 'qa', data: Array.from({ length: 8 }, (unusedValue, id) => ({ id })) };
  const batches = splitWebhookBatches(payload, Math.floor(Buffer.byteLength(JSON.stringify(payload)) / 2));
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap((batch) => batch.data), payload.data);
  const oversized = { event: 'messages.set', data: [{ text: 'x'.repeat(1000) }] };
  assert.deepEqual(splitWebhookBatches(oversized, 100), [oversized]);
});

test('el emisor divide un 413 y conserva orden sin duplicar lotes aceptados', async () => {
  const controller = new WebhookController({}, {});
  const received = [];
  let rejected = 0;
  await controller.retryWebhookRequest({ post: async (unusedPath, payload) => {
    if (payload.data.length > 2) {
      rejected++;
      throw { response: { status: 413 } };
    }
    received.push(...payload.data);
  } }, { event: 'messages.set', instance: 'qa', data: [1, 2, 3, 4, 5, 6] }, 'qa', 'http://localhost', 'qa');
  assert.ok(rejected > 0);
  assert.deepEqual(received, [1, 2, 3, 4, 5, 6]);
});

test('un mensaje indivisible con 413 falla sin bucle de reintentos', async () => {
  const controller = new WebhookController({}, {});
  let calls = 0;
  await assert.rejects(controller.retryWebhookRequest({ post: async () => {
    calls++;
    throw { response: { status: 413 } };
  } }, { event: 'messages.set', data: [1] }, 'qa', 'http://localhost', 'qa'));
  assert.equal(calls, 1);
});
