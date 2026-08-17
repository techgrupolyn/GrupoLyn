import { describe, it, expect } from 'vitest';

function buildMediaMessageFromRaw(raw: unknown, messageId: string, chatId: string) {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const key = (record.key || {}) as Record<string, unknown>;
  const fromMe = key.fromMe !== false;

  const wrapper = (record.message && typeof record.message === 'object') ? (record.message as Record<string, unknown>) : record;
  const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'];
  const mediaType = mediaTypes.find((type) => Boolean((wrapper[type] as Record<string, unknown> | undefined)?.mediaKey)) || null;

  if (!mediaType) return null;

  const participantJid = typeof key.participant === 'string' ? key.participant : typeof key.participantJid === 'string' ? key.participantJid : typeof key.remoteJid === 'string' ? key.remoteJid : chatId;

  return {
    key: {
      id: typeof key.id === 'string' ? key.id : messageId,
      remoteJid: typeof key.remoteJid === 'string' ? key.remoteJid : chatId,
      fromMe: fromMe === true,
      participantJid,
    },
    message: {
      [mediaType]: wrapper[mediaType] || {},
    },
    messageTimestamp: typeof record.messageTimestamp === 'number' ? record.messageTimestamp : Math.floor(Date.now() / 1000),
  } as any;
}

describe('buildMediaMessageFromRaw', () => {
  const baseRaw = (mediaType: string) => ({
    key: { id: 'm1', remoteJid: '5491111111111@s.whatsapp.net', fromMe: false },
    message: { [mediaType]: { mediaKey: 'abc123' } },
    messageTimestamp: 1700000000,
  });

  it('retorna null cuando raw es nulo', () => {
    expect(buildMediaMessageFromRaw(null, 'm1', 'c1')).toBeNull();
  });

  it('retorna null cuando no hay mediaKey', () => {
    expect(buildMediaMessageFromRaw({ key: {} }, 'm1', 'c1')).toBeNull();
  });

  it('construye imagen', () => {
    const result = buildMediaMessageFromRaw(baseRaw('imageMessage'), 'm1', 'c1');
    expect(result?.message?.imageMessage?.mediaKey).toBe('abc123');
    expect(result?.key?.id).toBe('m1');
    expect(result?.key?.remoteJid).toBe('5491111111111@s.whatsapp.net');
  });

  it('usa message como wrapper cuando raw directo no tiene message', () => {
    const raw = {
      key: { id: 'm2', remoteJid: 'c1' },
      videoMessage: { mediaKey: 'vid' },
      messageTimestamp: 1700000001,
    };

    const result = buildMediaMessageFromRaw(raw, 'm2', 'c1');
    expect(result?.message?.videoMessage?.mediaKey).toBe('vid');
    expect(result?.key?.id).toBe('m2');
  });

  it('usa fallback de messageTimestamp cuando falta', () => {
    const raw = { key: { id: 'm3', remoteJid: 'c1' }, message: { audioMessage: { mediaKey: 'aud' } } };
    const before = Math.floor(Date.now() / 1000);
    const result = buildMediaMessageFromRaw(raw, 'm3', 'c1');
    const after = Math.floor(Date.now() / 1000);

    expect(result?.messageTimestamp).toBeGreaterThanOrEqual(before);
    expect(result?.messageTimestamp).toBeLessThanOrEqual(after);
  });
});
