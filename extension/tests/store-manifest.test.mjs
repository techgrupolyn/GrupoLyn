import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const productionManifest = JSON.parse(await readFile(new URL('../manifest.production.json', import.meta.url), 'utf8'));
const localManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('el manifiesto de distribución limita los hosts a producción y WhatsApp Web', () => {
  assert.deepEqual(productionManifest.host_permissions, [
    'https://ceo.grupolyn.com/*',
    'https://web.whatsapp.com/*',
  ]);
  assert.match(productionManifest.content_security_policy.extension_pages, /https:\/\/ceo\.grupolyn\.com/);
  assert.doesNotMatch(JSON.stringify(productionManifest), /localhost|127\.0\.0\.1/);
  assert.ok(productionManifest.permissions.includes('sidePanel'));
  assert.equal(productionManifest.side_panel.default_path, 'src/sidepanel/sidepanel.html');
  assert.doesNotMatch(JSON.stringify(productionManifest.host_permissions), /https:\/\/\*\//);
});

test('el manifiesto local limita los hosts de desarrollo a loopback', () => {
  assert.deepEqual(localManifest.host_permissions, [
    'https://ceo.grupolyn.com/*',
    'http://127.0.0.1:3003/*',
    'http://localhost:3003/*',
    'https://web.whatsapp.com/*',
  ]);
  assert.doesNotMatch(JSON.stringify(localManifest.host_permissions), /http:\/\/\*\//);
});