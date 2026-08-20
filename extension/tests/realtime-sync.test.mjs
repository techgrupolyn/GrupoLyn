import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../src/content/content.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

test('la extensión combina SSE con actualización rápida de respaldo', () => {
  assert.match(content, /const LIVE_SYNC_VISIBLE_INTERVAL_MS = 5_000/);
  assert.match(content, /const LIVE_SYNC_HIDDEN_INTERVAL_MS = 15_000/);
  assert.match(content, /await backendMessage\('SYNC_LIVE'\)/);
  assert.match(content, /new EventSource\(/);
  assert.match(content, /scheduleRealtimeReconnect\(\)/);
});

test('la reconciliación incluye grupos visibles sin contador para limpiar estados leídos', () => {
  assert.match(content, /observedChatIds/);
  assert.match(worker, /observedChatIds/);
  assert.match(worker, /message\.type === 'SYNC_LIVE'/);
  assert.match(worker, /Promise\.all\(\[syncChats\(\), syncMessages\(\)\]\)/);
});