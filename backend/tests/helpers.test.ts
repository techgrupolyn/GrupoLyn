import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureRemoteJid, resolveChatIdVariants, normalizeRemoteJid, toDate } from '../src/helpers';

describe('ensureRemoteJid', () => {
  it('agrega @s.whatsapp.net cuando falta dominio', () => {
    expect(ensureRemoteJid('5491111111111')).toBe('5491111111111@s.whatsapp.net');
  });

  it('no modifica jids que ya tienen dominio', () => {
    expect(ensureRemoteJid('5491111111111@s.whatsapp.net')).toBe('5491111111111@s.whatsapp.net');
    expect(ensureRemoteJid('5491111111111@lid')).toBe('5491111111111@lid');
  });

  it('limpia espacios', () => {
    expect(ensureRemoteJid(' 5491111111111 ')).toBe('5491111111111@s.whatsapp.net');
  });

  it('retorna cadena vacía para entrada vacía', () => {
    expect(ensureRemoteJid('')).toBe('');
  });
});

describe('resolveChatIdVariants', () => {
  it('genera variantes para jid numerico', () => {
    const variants = resolveChatIdVariants('5491111111111@s.whatsapp.net');
    expect(variants).toContain('5491111111111@s.whatsapp.net');
    expect(variants).toContain('5491111111111@lid');
  });

  it('genera variantes para @lid', () => {
    const variants = resolveChatIdVariants('5491111111111@lid');
    expect(variants).toContain('5491111111111@lid');
    expect(variants).toContain('5491111111111@s.whatsapp.net');
  });

  it('no duplica variantes', () => {
    const variants = resolveChatIdVariants('5491111111111@s.whatsapp.net');
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('retorna vacio para entrada vacia', () => {
    expect(resolveChatIdVariants('')).toEqual([]);
  });
});

describe('normalizeRemoteJid', () => {
  it('extrae solo el numero del jid', () => {
    expect(normalizeRemoteJid('5491111111111@s.whatsapp.net')).toBe('5491111111111');
  });

  it('retorna el valor si no tiene @', () => {
    expect(normalizeRemoteJid('5491111111111')).toBe('5491111111111');
  });
});

describe('toDate', () => {
  it('parsea string ISO', () => {
    expect(toDate('2024-01-01T00:00:00.000Z').getUTCFullYear()).toBe(2024);
  });

  it('parsea timestamp en segundos', () => {
    expect(toDate(1735603200).getUTCFullYear()).toBe(2024);
  });

  it('parsea timestamp en milisegundos cuando tiene mas de 10 digitos', () => {
    expect(toDate(1735603200000).getUTCFullYear()).toBe(2024);
  });

  it('fallback a fecha actual cuando no parsea', () => {
    const now = new Date();
    const result = toDate('');
    expect(result.getUTCFullYear()).toBe(now.getUTCFullYear());
  });
});
