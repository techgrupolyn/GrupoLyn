import { describe, expect, it } from 'vitest';
import { unwrapWhatsAppContent, nonTextWhatsAppKind } from '../whatsapp-content.ts';

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

  it.each([
    ['reactionMessage', 'reaction'], ['albumMessage', 'album'], ['contactMessage', 'contact'],
    ['contactsArrayMessage', 'contact'], ['groupStatusMentionMessage', 'status_mention'], ['ptvMessage', 'video'],
  ])('identifica %s sin convertirlo en un texto vacío', (field, kind) => {
    expect(nonTextWhatsAppKind({ [field]: {}, messageContextInfo: {}, senderKeyDistributionMessage: {} })).toBe(kind);
    expect(nonTextWhatsAppKind({}, field)).toBe(kind);
    expect(nonTextWhatsAppKind({ ephemeralMessage: { message: { [field]: {} } } })).toBe(kind);
  });

  it.each(['conversation', 'secretEncryptedMessage', 'protocolMessage', 'unknown'])('no descarta contenido no recuperado de tipo %s', (field) => {
    expect(nonTextWhatsAppKind({ [field]: {}, messageContextInfo: {} }, field)).toBeNull();
    expect(nonTextWhatsAppKind({}, field)).toBeNull();
  });

  it('no usa una cita ni metadatos inconsistentes para excluir texto real', () => {
    expect(nonTextWhatsAppKind({ conversation: 'Texto real' }, 'reactionMessage')).toBeNull();
    expect(nonTextWhatsAppKind('Texto real', 'reactionMessage')).toBeNull();
    expect(nonTextWhatsAppKind({ extendedTextMessage: { text: 'Texto real', contextInfo: { quotedMessage: { albumMessage: {} } } } })).toBeNull();
    expect(nonTextWhatsAppKind({ contextInfo: { quotedMessage: { reactionMessage: {} } } })).toBeNull();
  });
});
