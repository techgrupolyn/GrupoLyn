import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sidepanel = await readFile(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('los resúmenes usan el chat público devuelto por la API', () => {
  assert.match(sidepanel, /const resolvedChatId = String\(data\?\.chatId \|\| chat\.chat_id\)/);
  assert.match(sidepanel, /state\.summaries\[resolvedChatId\]/);
});

test('al abrir un chat se recupera el resumen persistido del rol elegido', () => {
  assert.match(sidepanel, /async function hydrateSummaryForChat/);
  assert.match(sidepanel, /\/chat\/\$\{encodeURIComponent\(id\)\}\/summaries/);
  assert.match(sidepanel, /summary\?\.especialista_id/);
});