import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getLatestMessageTimestamp, mergeMessages } from '../src/lib/message-sync.js';

const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const productionManifest = JSON.parse(await readFile(new URL('../manifest.production.json', import.meta.url), 'utf8'));

async function startWorker(initial = {}, fetchStatus = 200) {
  const storage = structuredClone(initial);
  const listeners = {};
  const requests = [];
  const errors = [];
  const chrome = {
    runtime: {
      getManifest: () => productionManifest,
      onMessage: { addListener: (callback) => { listeners.message = callback; } },
      onInstalled: { addListener: (callback) => { listeners.installed = callback; } },
      onStartup: { addListener: (callback) => { listeners.startup = callback; } },
    },
    storage: {
      local: {
        get: async (keys) => Array.isArray(keys)
          ? Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]))
          : { ...structuredClone(keys), ...structuredClone(storage) },
        set: async (values) => { Object.assign(storage, structuredClone(values)); },
        remove: async (key) => { delete storage[key]; },
      },
      onChanged: { addListener: (callback) => { listeners.changed = callback; } },
    },
    alarms: { create: async () => {}, onAlarm: { addListener: (callback) => { listeners.alarm = callback; } } },
    sidePanel: { setPanelBehavior: async () => {} },
  };
  const context = vm.createContext({
    chrome, URL, AbortController, setTimeout, clearTimeout,
    getLatestMessageTimestamp, mergeMessages,
    console: { log: () => {}, warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: fetchStatus === 200, status: fetchStatus, text: async () => 'Activación no válida', json: async () => [] };
    },
  });
  const executable = worker.replace(/^import[^\n]+\n/, '').replace('(async function init() {', 'var initialization = (async function init() {');
  vm.runInContext(executable, context);
  await context.initialization;
  return { storage, listeners, requests, errors };
}

test('el worker completo conserva credenciales y caché durante actualización y reinicio', async () => {
  const saved = {
    backendUrl: 'https://ceo.grupolyn.com', extensionActivationId: 'qa-activation-not-real',
    employee: { id: 'qa-employee' }, authorized: true, privacyMode: true,
    messages: { qa: [{ id: 'message-qa', texto: 'Contenido ficticio' }] },
    messageCacheSeeded: true, lastMessageCursor: '2026-09-28T00:00:00Z',
  };
  const harness = await startWorker(saved);
  await harness.listeners.installed({ reason: 'update' });
  await harness.listeners.startup();
  for (const key of Object.keys(saved)) assert.deepEqual(harness.storage[key], saved[key], key);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.requests.length > 0);
  assert.ok(harness.requests.every(({ url, options }) => url.startsWith('https://ceo.grupolyn.com/api/') && options.headers['X-Extension-Activation'] === saved.extensionActivationId));
});

test('la instalación productiva nueva no sincroniza sin activación ni usa localhost', async () => {
  const harness = await startWorker();
  await harness.listeners.installed({ reason: 'install' });
  await harness.listeners.startup();
  assert.equal(harness.storage.backendUrl, 'https://ceo.grupolyn.com');
  assert.equal(harness.storage.extensionActivationId, '');
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.errors.length, 0);
});

test('la migración del perfil local a producción conserva su activación', async () => {
  const harness = await startWorker({ backendUrl: 'http://localhost:3003', extensionActivationId: 'qa-retained' });
  await harness.listeners.installed({ reason: 'update' });
  assert.equal(harness.storage.backendUrl, 'https://ceo.grupolyn.com');
  assert.equal(harness.storage.extensionActivationId, 'qa-retained');
  assert.ok(harness.requests.every(({ url }) => url.startsWith('https://ceo.grupolyn.com/api/')));
});

test('un 401 informa el fallo sin borrar credenciales ni intentar rutas administrativas', async () => {
  const harness = await startWorker({ backendUrl: 'https://ceo.grupolyn.com', extensionActivationId: 'qa-invalid' }, 401);
  const response = await new Promise((resolve) => harness.listeners.message({ type: 'CONNECTION_STATE' }, {}, resolve));
  assert.equal(response.ok, false);
  assert.match(response.error, /HTTP 401/);
  assert.equal(harness.storage.extensionActivationId, 'qa-invalid');
  assert.ok(harness.requests.every(({ url }) => !url.includes('/ceo/') && !url.includes('localhost')));
});

test('la lista blanca incluye rutas necesarias y excluye administración CEO', () => {
  assert.match(worker, /\^\\\/pendientes\$\//);
  assert.match(worker, /resolve-name/);
  assert.doesNotMatch(worker, /\/ceo\/metrics/);
  assert.doesNotMatch(worker, /\/instance\/logout/);
});

test('el icono de la extensión abre el panel lateral en cada ciclo de inicio', () => {
  assert.match(worker, /async function configureSidePanel\(\) \{\s+await chrome\.sidePanel\.setPanelBehavior\(\{ openPanelOnActionClick: true \}\);\s+\}/);
  assert.match(worker, /initialized = true;\s+await configureSidePanel\(\);\s+await startActivatedWorkspace\(\);/);
  assert.match(worker, /chrome\.runtime\.onStartup\.addListener[\s\S]*?await configureSidePanel\(\);\s+await startActivatedWorkspace\(\);/);
});

test('una actualización preserva la activación y reinicia el espacio de trabajo sin pedir un código nuevo', () => {
  assert.match(worker, /chrome\.runtime\.onInstalled\.addListener[\s\S]*?extensionActivationId: ''/);
  assert.match(worker, /const existing = await chrome\.storage\.local\.get\(defaults\);\s+await chrome\.storage\.local\.set\(existing\);/);
  assert.match(worker, /await configureSidePanel\(\);\s+await startActivatedWorkspace\(\);/);
});
test('la edición de producción migra una URL local guardada sin borrar la activación', () => {
  assert.match(worker, /function productionBackendUrlFromManifest\(\)/);
  assert.match(worker, /function localBackendAllowedByManifest\(\)/);
  assert.match(worker, /async function getConfiguredBackendStorage\(\)/);
  assert.match(worker, /const storage = await getStorage\(\['backendUrl', 'extensionActivationId'\], \{/);
  assert.doesNotMatch(worker, /async function getConfiguredBackendStorage\(\) \{\s+const storage = await getConfiguredBackendStorage\(\);/);
  assert.match(worker, /await chrome\.storage\.local\.set\(\{ backendUrl: productionUrl \}\)/);
});
