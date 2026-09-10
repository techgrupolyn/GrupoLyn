import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

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
  assert.match(worker, /await chrome\.storage\.local\.set\(\{ backendUrl: productionUrl \}\)/);
});