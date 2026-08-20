import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../server.ts';

const client = request(app);

describe('Server - protección de APIs de extensión', () => {
  it('rechaza chats sin una activación válida', async () => {
    const res = await client.get('/api/chats');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/activarse con un código válido/i);
  });

  it('rechaza una extensión sin código de activación', async () => {
    const res = await client
      .get('/api/chats')
      .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('activarse');
  });

  it('no permite consultar mensajes sin credenciales', async () => {
    const res = await client.get('/api/chats/120363000000000@g.us/mensajes');
    expect(res.status).toBe(401);
  });

  it('no permite generar IA sin credenciales', async () => {
    const [summaryResponse, replyResponse] = await Promise.all([
      client.post('/api/chat/summary').send({ chatId: '120363000000000@g.us' }),
      client.post('/api/chat/reply').send({ chatId: '120363000000000@g.us' }),
    ]);

    expect(summaryResponse.status).toBe(401);
    expect(replyResponse.status).toBe(401);
  });

  it('bloquea rutas legacy de Evolution sin sesión CEO', async () => {
    const res = await client.delete('/api/instance/logout');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/sesión CEO|activación válida/i);
  });

  it('no concede CORS a un sitio web ajeno', async () => {
    const res = await client.get('/api/chats').set('Origin', 'https://attacker.example');
    expect(res.status).toBe(403);
  });
});

describe('Server - webhook', () => {
  it('acepta un evento de mensaje en pruebas', async () => {
    const payload = {
      event: 'MESSAGES_UPSERT',
      data: {
        key: { remoteJid: '120363000000000@g.us', fromMe: false, id: 'msg-1' },
        message: { conversation: 'Hola' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    const res = await client.post('/webhook/evolution').send(payload).timeout(20000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
