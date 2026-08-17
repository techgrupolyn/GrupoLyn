import test from 'node:test';
import assert from 'node:assert/strict';
import { getLatestMessageTimestamp, mergeMessages } from '../src/lib/message-sync.js';

test('mergeMessages ordena y conserva mensajes de ambas sincronizaciones', () => {
  const merged = mergeMessages([{ id: 'one', timestamp: '2026-08-16T10:00:00.000Z', texto: 'primero' }], [
    { id: 'three', timestamp: '2026-08-16T12:00:00.000Z', texto: 'tercero' },
    { id: 'two', timestamp: '2026-08-16T11:00:00.000Z', texto: 'segundo' },
  ], 200);
  assert.deepEqual(merged.map((message) => message.id), ['one', 'two', 'three']);
});

test('mergeMessages actualiza mensajes repetidos en lugar de duplicarlos', () => {
  const merged = mergeMessages([{ id: 'message-1', timestamp: '2026-08-16T10:00:00.000Z', texto: 'versión previa' }], [
    { id: 'message-1', timestamp: '2026-08-16T10:01:00.000Z', texto: 'versión editada' },
  ], 200);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].texto, 'versión editada');
});

test('mergeMessages limita el caché sin perder los mensajes más recientes', () => {
  const merged = mergeMessages([], [
    { id: 'one', timestamp: '2026-08-16T10:00:00.000Z' },
    { id: 'two', timestamp: '2026-08-16T11:00:00.000Z' },
    { id: 'three', timestamp: '2026-08-16T12:00:00.000Z' },
  ], 2);
  assert.deepEqual(merged.map((message) => message.id), ['two', 'three']);
});

test('getLatestMessageTimestamp no depende del orden previo del caché', () => {
  const timestamp = getLatestMessageTimestamp([
    { id: 'new', timestamp: '2026-08-16T12:00:00.000Z' },
    { id: 'old', timestamp: '2026-08-16T10:00:00.000Z' },
  ]);
  assert.equal(timestamp, '2026-08-16T12:00:00.000Z');
});