import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sidepanel = await readFile(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('el informe global usa solo rutas permitidas para la extensión activada', () => {
  assert.match(worker, /global-summary/);
  assert.match(worker, /global-summaries/);
  assert.match(sidepanel, /directBackendRequest\('\/chat\/global-summary'/);
  assert.match(sidepanel, /global-summaries\/latest/);
});

test('el modo local sin activación está limitado a hosts loopback', () => {
  assert.match(worker, /isLocalDevelopmentBackend/);
  assert.match(worker, /host === '127\.0\.0\.1' \|\| host === 'localhost' \|\| host === '::1'/);
  assert.match(sidepanel, /isLocalDevelopmentBackend/);
});

test('el panel prioriza el informe global y muestra el contador de mensajes pendientes', async () => {
  const html = await readFile(new URL('../src/sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /Informe global/);
  assert.match(html, /btn-generate-global-report/);
  assert.ok(html.indexOf('id="tab-global-report"') < html.indexOf('id="tab-pending-chats"'));
  assert.match(html, /tab-pending-count/);
  assert.match(sidepanel, /function renderPendingUnreadCounter/);
  assert.match(sidepanel, /if \(success\) await loadChats\(\);/);
  assert.equal(manifest.version, '1.0.10');
});