import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('el manifiesto de distribución limita los hosts al servicio y WhatsApp Web', () => {
  assert.deepEqual(manifest.host_permissions, [
    'https://ceo.grupolyn.com/*',
    'https://web.whatsapp.com/*',
  ]);
  assert.match(manifest.content_security_policy.extension_pages, /https:\/\/ceo\.grupolyn\.com/);
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel.default_path, 'src/sidepanel/sidepanel.html');
  assert.doesNotMatch(JSON.stringify(manifest.host_permissions), /https:\/\/\*\//);
});