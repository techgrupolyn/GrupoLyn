import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createClubProtocolRouter } from '../protocol-club-api.ts';

const user = { id: 42, externalId: 'f779edfa-645e-455c-8b82-2e3e229a1d4a', role: 'employee:interiorista' };
const conversationId = '8eef7656-c836-41f6-9bfa-e1ea280e6bf1';
const consultationId = 'cb0df312-50b9-4dbd-9ce3-a39f15787740';
const serviceToken = 'synthetic-server-only-token-long-enough-123';

function setup(enabled = true) {
  const ask = vi.fn().mockResolvedValue({
    id: consultationId, answer: 'Respuesta citada', classification: 'no_urgente',
    sources: [{ doc_id: '1abcdefghijklmno', name: 'Control', seccion: 'página 2', cita: 'Cita literal verificable', modifiedTime: '', revision: '' }],
    derivationRole: 'PMC', derivationPerson: null, contradiction: null, validation: 'ok', corpusVersionId: 'v1',
  });
  const confirm = vi.fn().mockResolvedValue(true);
  const resolveUser = vi.fn().mockResolvedValue(user);
  const app = express();
  app.use(express.json());
  app.use('/api/club/protocolos', createClubProtocolRouter({
    enabled, serviceToken, resolveUser, ask, confirm,
    status: async () => ({ versionId: 'v1', updatedAt: '2026-11-10T00:00:00Z', lastSyncedAt: '2026-11-09T00:00:00Z', fileCount: 7 }),
    now: () => Date.parse('2026-11-10T01:00:00Z'),
  }));
  const authorized = () => request(app).post('/api/club/protocolos/consultas')
    .set('Authorization', `Bearer ${serviceToken}`).set('X-Club-User-Id', user.externalId);
  return { app, ask, confirm, resolveUser, authorized };
}

describe('Club LYN protocol bridge', () => {
  it('fails closed when disabled or missing service credentials', async () => {
    const { app } = setup(false);
    expect((await request(app).get('/api/club/protocolos/estado')).status).toBe(503);
  });

  it('rejects direct browser calls, wrong secrets and invalid Club identities', async () => {
    const { app, ask, resolveUser } = setup();
    const path = '/api/club/protocolos/estado';
    expect((await request(app).get(path).set('Origin', 'https://club-lyn.grupolyn.com').set('Authorization', `Bearer ${serviceToken}`)).status).toBe(403);
    expect((await request(app).get(path).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get(path).set('Authorization', `Bearer ${serviceToken}`)).status).toBe(400);
    expect((await request(app).get(path).set('Authorization', `Bearer ${serviceToken}`).set('X-Club-User-Id', 'invalid')).status).toBe(400);
    resolveUser.mockResolvedValueOnce(null);
    expect((await request(app).get(path).set('Authorization', `Bearer ${serviceToken}`).set('X-Club-User-Id', user.externalId)).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });

  it('uses verified identity and returns a sourced answer without exposing the service token', async () => {
    const { authorized, ask } = setup();
    const result = await authorized().send({ usuario_id: user.externalId, cargo: 'superadmin', canal: 'club_lyn', conversacion_id: conversationId, pregunta: '¿Qué debo hacer?', contexto: [{ author: 'user', text: 'Seguimiento' }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ consulta_id: consultationId, clasificacion: 'no_urgente', respuesta: 'Respuesta citada', fuentes: [{ documento: 'Control', seccion: 'página 2', url: 'https://drive.google.com/file/d/1abcdefghijklmno/view' }], corpus: { version: 'v1' } });
    expect(JSON.stringify(result.body)).not.toContain(serviceToken);
    expect(ask).toHaveBeenCalledWith(user, '¿Qué debo hacer?', [{ author: 'user', text: 'Seguimiento' }]);
  });

  it('does not accept a different user or malformed conversation', async () => {
    const { authorized, ask } = setup();
    const body = { usuario_id: conversationId, canal: 'club_lyn', conversacion_id: conversationId, pregunta: 'Pregunta' };
    expect((await authorized().send(body)).status).toBe(400);
    expect((await authorized().send({ ...body, usuario_id: user.externalId, conversacion_id: 'bad' })).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });

  it('limits consultations for each verified user', async () => {
    const { authorized, ask } = setup();
    const body = { usuario_id: user.externalId, canal: 'club_lyn', conversacion_id: conversationId, pregunta: '¿Qué debo hacer?' };
    for (let attempt = 0; attempt < 20; attempt += 1) expect((await authorized().send(body)).status).toBe(200);
    expect((await authorized().send(body)).status).toBe(429);
    expect(ask).toHaveBeenCalledTimes(20);
  });

  it('reports corpus staleness and saves feedback only for the verified user', async () => {
    const { app, confirm } = setup();
    const base = request(app).get('/api/club/protocolos/estado').set('Authorization', `Bearer ${serviceToken}`).set('X-Club-User-Id', user.externalId);
    expect((await base).body).toMatchObject({ versionId: 'v1', fileCount: 7, desactualizado: true });
    const saved = await request(app).post(`/api/club/protocolos/consultas/${consultationId}/confirmacion`).set('Authorization', `Bearer ${serviceToken}`).set('X-Club-User-Id', user.externalId).send({ resuelta: false });
    expect(saved.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(user, consultationId, false);
  });
});
