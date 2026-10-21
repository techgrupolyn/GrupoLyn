import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPhoneEvidenceLookup, createPhoneEvidenceRouter, phoneEvidenceConfigFromEnv, type PhoneEvidenceConfig } from '../phone-evidence.ts';
import { normalizePhone } from '../phone-normalization.ts';

const token = 'local-test-only-'.repeat(4);
const path = '/api/integrations/club-lyn/phone-evidence';
function setup(overrides: Partial<PhoneEvidenceConfig> = {}) {
  const lookup = vi.fn().mockResolvedValue({ project: 'Dana', last_message_at: '2026-01-15T10:00:00.000Z', texto: 'must never leave the server' });
  const app = express();
  app.use(path, createPhoneEvidenceRouter({ enabled: true, token, accountIds: ['authorized'], ...overrides }, lookup));
  const client = request(app);
  return { lookup, client, send: (body: unknown) => client.post(path).set('Authorization', `Bearer ${token}`).send(body) };
}

describe('Normalización sin adivinar el país', () => {
  it.each([
    ['+34 600 123 456', undefined, '+34600123456', 'ES', '+34'],
    ['0034 600 123 456', undefined, '+34600123456', 'ES', '+34'],
    ['+58 412 1234567', undefined, '+584121234567', 'VE', '+58'],
    ['+57 300 1234567', undefined, '+573001234567', 'CO', '+57'],
    ['600 123 456', 'ES', '+34600123456', 'ES', '+34'],
    ['0412 1234567', 'VE', '+584121234567', 'VE', '+58'],
  ])('normaliza %s con país %s', (input, country, phone, expectedCountry, callingCode) => {
    expect(normalizePhone(input, country)).toEqual({ phone, country: expectedCountry, calling_code: callingCode });
  });
  it.each(['600 123 456', '34600123456', '04121234567'])('pide país para %s sin prefijo explícito', input => {
    expect(() => normalizePhone(input)).toThrow('country_required');
  });
  it.each(['+34 123', '+999600123456', '+34 600123456 ext 12', 'tel:+34600123456', 'Hola +34600123456', '+34+600123456', '', null, 34600123456])('rechaza valores inválidos %s', input => {
    expect(() => normalizePhone(input)).toThrow();
  });
  it('no cambia un prefijo explícito para hacerlo encajar en otro país', () => {
    expect(() => normalizePhone('+584121234567', 'ES')).toThrow('country_mismatch');
    expect(() => normalizePhone('600123456', 'ZZ')).toThrow('invalid_country');
  });
});

describe('API privada de evidencia telefónica', () => {
  it('permanece desactivada por defecto y no hereda otras credenciales', async () => {
    expect(phoneEvidenceConfigFromEnv({ SUPABASE_SOURCE_SECRET_KEY: 'secret' })).toEqual({ enabled: false, token: '', accountIds: [] });
    const test = setup({ enabled: false });
    expect((await test.send({ phone: '+34600123456' })).status).toBe(404);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('deduplica cuentas explícitas sin habilitar comodines', () => {
    expect(phoneEvidenceConfigFromEnv({ CLUB_PHONE_EVIDENCE_ACCOUNT_IDS: ' alpha, beta,alpha, ' }).accountIds).toEqual(['alpha', 'beta']);
  });
  it.each([{ token: '' }, { token: 'short' }, { accountIds: [] }, { accountIds: ['*'] }])('rechaza configuración insegura %j', async config => {
    const test = setup(config);
    expect((await test.send({ phone: '+34600123456' })).status).toBe(503);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('exige su token privado y no acepta sesiones ni credenciales de extensión', async () => {
    const test = setup();
    for (const authorization of ['', 'Basic token', 'Bearer session-ceo', 'Bearer another-secret']) {
      const result = await test.client.post(path).set('Authorization', authorization).send({ phone: '+34600123456' });
      expect(result.status).toBe(401);
      expect(result.headers['cache-control']).toBe('no-store');
    }
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('no admite llamadas del frontend aunque lleven el token', async () => {
    const test = setup();
    expect((await test.client.post(path).set('Origin', 'https://club-lyn.grupolyn.com').set('Authorization', `Bearer ${token}`).send({ phone: '+34600123456' })).status).toBe(403);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('normaliza antes de buscar y devuelve solo campos expresamente permitidos', async () => {
    const test = setup();
    const result = await test.send({ phone: '600 123 456', country: 'ES' });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(test.lookup).toHaveBeenCalledWith('+34600123456', ['authorized']);
    expect(result.body).toEqual({
      phone: '+34600123456', country: 'ES', calling_code: '+34', verified: true,
      method: 'WhatsApp', reason: 'message_found', project: 'Dana', last_message_at: '2026-01-15T10:00:00.000Z',
    });
  });
  it('diferencia falta de evidencia de un fallo de consulta', async () => {
    const test = setup();
    test.lookup.mockResolvedValueOnce(null);
    const absent = await test.send({ phone: '+34600123456' });
    expect(absent.status).toBe(200);
    expect(absent.body).toMatchObject({ verified: false, reason: 'no_evidence', method: null, project: null, last_message_at: null });
    test.lookup.mockRejectedValueOnce(new Error('private database details'));
    const failed = await test.send({ phone: '+34600123456' });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ code: 'evidence_unavailable' });
    expect(failed.headers['retry-after']).toBe('60');
  });
  it.each([{ phone: '600123456' }, { phone: '+34 12' }, { phone: '+584121234567', country: 'ES' }])('no busca entradas que requieren corrección %j', async body => {
    const test = setup();
    expect((await test.send(body)).status).toBe(422);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it.each([{ phone: '+34600123456', accountIds: ['foreign'] }, { phone: '+34600123456', verified: true }, ['+34600123456']])('impide seleccionar el ámbito desde el cuerpo %j', async body => {
    const test = setup();
    expect((await test.send(body)).status).toBe(400);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('no admite teléfonos en la URL ni devuelve errores del parser', async () => {
    const test = setup();
    expect((await test.client.get(`${path}?phone=+34600123456`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    const malformed = await test.client.post(path).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send('{"phone":');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ code: 'invalid_request' });
    expect((await test.send({ phone: '1'.repeat(3000) })).status).toBe(413);
    expect(test.lookup).not.toHaveBeenCalled();
  });
  it('limita las consultas del cliente autenticado', async () => {
    const test = setup();
    for (let count = 0; count < 60; count++) expect((await test.send({ phone: '+34600123456' })).status).toBe(200);
    const result = await test.send({ phone: '+34600123456' });
    expect(result.status).toBe(429);
    expect(test.lookup).toHaveBeenCalledTimes(60);
  });
  it('acota la consulta, usa parámetros y revierte/libera ante error', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    const lookup = createPhoneEvidenceLookup({ connect } as unknown as Parameters<typeof createPhoneEvidenceLookup>[0]);
    await lookup('+34600123456', ['allowed']);
    expect(query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
    expect(query.mock.calls[1][0]).toContain("statement_timeout='5s'");
    expect(query.mock.calls[2][1]).toEqual(['34600123456', ['allowed']]);
    expect(query.mock.calls[3][0]).toBe('COMMIT');
    query.mockClear();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('query failed'));
    await expect(lookup('+34600123456', ['allowed'])).rejects.toThrow('query failed');
    expect(query.mock.calls[3][0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(2);
    await expect(lookup('+34600123456', [])).rejects.toThrow('Invalid evidence scope');
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
