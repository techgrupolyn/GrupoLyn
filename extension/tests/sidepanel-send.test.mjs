import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sidepanel = await readFile(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('el envío seleccionado usa el canal individual autorizado de la extensión', () => {
  const sendSelectedStart = sidepanel.indexOf('async function sendSelectedReplies()');
  const sendSelectedEnd = sidepanel.indexOf('async function generateSummary()', sendSelectedStart);
  const sendSelected = sidepanel.slice(sendSelectedStart, sendSelectedEnd);
  assert.match(sendSelected, /backendMessage\('SEND_TEXT'/);
  assert.match(sendSelected, /respuestaId: data\.respuestaId/);
  assert.doesNotMatch(sendSelected, /\/batch\/reply/);
});

test('el envío seleccionado conserva una pausa controlada entre chats', () => {
  assert.match(sidepanel, /setTimeout\(resolve, 1_200\)/);
});