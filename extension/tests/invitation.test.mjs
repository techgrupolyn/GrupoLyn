import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivationCode } from '../src/lib/invitation.js';

function codeFor(url, secret = 'abcdefghijklmnopqrstuvwxyz012345') {
  return `LYN1.${Buffer.from(url).toString('base64url')}.${secret}`;
}

test('parseActivationCode obtiene el backend HTTPS incluido en el código', () => {
  assert.deepEqual(parseActivationCode(codeFor('https://ventas.example.com/ruta')), {
    backendUrl: 'https://ventas.example.com',
    code: codeFor('https://ventas.example.com/ruta'),
  });
});

test('parseActivationCode permite localhost para desarrollo', () => {
  assert.equal(parseActivationCode(codeFor('http://127.0.0.1:3003'))?.backendUrl, 'http://127.0.0.1:3003');
});

test('parseActivationCode rechaza esquemas inseguros remotos y formatos inválidos', () => {
  assert.equal(parseActivationCode(codeFor('http://ventas.example.com')), null);
  assert.equal(parseActivationCode('LYN1.invalido.secreto'), null);
});