import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app, isCeoAdministratorRole, isCeoConsultationRoute } from '../server.ts';

const client = request(app);

describe('Server - rutas adicionales protegidas', () => {
  it('bloquea sincronización incremental sin activación', async () => {
    const res = await client.get('/api/chats/120363000000000@g.us/mensajes/latest?since=');
    expect(res.status).toBe(401);
  });

  it('bloquea envíos sin activación', async () => {
    const res = await client.post('/api/enviar').send({ chatId: '', texto: '' });
    expect(res.status).toBe(401);
  });
});

describe('Server - seguridad CEO', () => {
  it('limita el rol público a consultas y lo excluye de permisos administrativos', () => {
    expect(isCeoConsultationRoute('/ceo/ask')).toBe(true);
    expect(isCeoConsultationRoute('/ceo/metrics')).toBe(false);
    expect(isCeoAdministratorRole('consulta_publica')).toBe(false);
    expect(isCeoAdministratorRole('superadmin')).toBe(true);
  });

  it('rechaza un login CEO sin credenciales antes de consultar datos', async () => {
    const res = await client.post('/api/auth/ceo-login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/obligatorios/i);
  });

  it('protege el reanálisis masivo de PMC con sesión CEO', async () => {
    const res = await client.post('/api/meetings/reanalyze-missing-pmc').send({});
    expect(res.status).toBe(401);
  });

  it('protege métricas CEO cuando no se presenta una sesión firmada', async () => {
    const res = await client.get('/api/ceo/metrics');
    expect(res.status).toBe(401);
  });

  it('protege consultas CEO cuando no se presenta una sesión firmada', async () => {
    const res = await client.post('/api/ceo/ask').send({ pregunta: 'Reporte semanal' });
    expect(res.status).toBe(401);
  });

  it('protege la administración de Google Drive y permite que Google alcance el callback OAuth', async () => {
    const protectedResponse = await client.get('/api/google-drive/status');
    const callbackResponse = await client.get('/api/integrations/google-drive/oauth/callback').query({ error: 'access_denied' });

    expect(protectedResponse.status).toBe(401);
    expect(callbackResponse.status).toBe(302);
  });
});

describe('Server - activación de extensiones', () => {
  it('exige una sesión CEO para generar códigos de activación', async () => {
    const res = await client.post('/api/extension/invitations').send({});
    expect(res.status).toBe(401);
  });

  it('mantiene público el canje, pero rechaza códigos vacíos', async () => {
    const res = await client.post('/api/extension/invitations/redeem').send({ code: '' });
    expect(res.status).toBe(400);
  });

  it('protege el historial de activaciones con sesión CEO', async () => {
    const res = await client.get('/api/extension/invitations');
    expect(res.status).toBe(401);
  });
});
