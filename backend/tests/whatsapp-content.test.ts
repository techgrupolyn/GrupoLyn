import { describe, expect, it } from 'vitest';
import { unwrapWhatsAppContent } from '../whatsapp-content.ts';

describe('contenido WhatsApp anidado', () => {
  it('recupera vídeo de associatedChildMessage dentro de mensaje efímero', () => {
    const video = { videoMessage: { caption: 'Vídeo QA', mediaKey: 'qa' } };
    expect(unwrapWhatsAppContent({ ephemeralMessage: { message: { associatedChildMessage: { message: video } } } })).toEqual(video);
  });

  it('conserva audio y no confunde una cita con el mensaje actual', () => {
    const audio = { audioMessage: { contextInfo: { quotedMessage: { conversation: 'No analizar como mensaje nuevo' } } } };
    expect(unwrapWhatsAppContent(audio)).toEqual(audio);
  });

  it('tolera entradas vacías y limita ciclos', () => {
    expect(unwrapWhatsAppContent(null)).toEqual({});
    const circular: Record<string, unknown> = {};
    circular.ephemeralMessage = { message: circular };
    expect(unwrapWhatsAppContent(circular)).toBe(circular);
  });
});
