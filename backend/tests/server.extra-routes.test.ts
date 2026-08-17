import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../server.ts';

const client = request(app);

describe('Server - rutas adicionales', () => {
  it('GET /api/chats/:id/mensajes/latest acepta since y devuelve array', async () => {
    const res = await client.get('/api/chats/120363000000000@g.us/mensajes/latest?since=');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/enviar rechaza payload vacío', async () => {
    const res = await client.post('/api/enviar').send({ chatId: '', texto: '' });
    expect(res.status).toBe(400);
  });
});

describe('Server - seguridad CEO', () => {
  it('rechaza un login CEO sin credenciales antes de consultar datos', async () => {
    const res = await client.post('/api/auth/ceo-login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/obligatorios/i);
  });

  it('protege métricas CEO cuando no se presenta una sesión firmada', async () => {
    const res = await client.get('/api/ceo/metrics');
    expect(res.status).toBe(401);
  });

  it('protege consultas CEO cuando no se presenta una sesión firmada', async () => {
    const res = await client.post('/api/ceo/ask').send({ pregunta: 'Reporte semanal' });
    expect(res.status).toBe(401);
  });
});
describe('Server - activación de extensiones', () => {
  it('exige una sesión CEO para generar códigos de activación', async () => {
    const res = await client.post('/api/extension/invitations').send({});
    expect(res.status).toBe(401);
  });

  it('rechaza códigos de activación vacíos antes de consultar invitaciones', async () => {
    const res = await client.post('/api/extension/invitations/redeem').send({ code: '' });
    expect(res.status).toBe(400);
  });
});
describe('Server - administración de invitaciones', () => {
  it('protege el historial de activaciones con sesión CEO', async () => {
    const res = await client.get('/api/extension/invitations');
    expect(res.status).toBe(401);
  });

  it('protege la invalidación de códigos con sesión CEO', async () => {
    const res = await client.delete('/api/extension/invitations/no-existe');
    expect(res.status).toBe(401);
  });
});