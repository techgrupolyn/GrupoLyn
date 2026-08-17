import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../server.ts';

const client = request(app);

describe('Server - rutas', () => {
  describe('GET /api/chats', () => {
    it('devuelve 200 y un array', async () => {
      const res = await client.get('/api/chats');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('Activación de extensión', () => {
    it('rechaza peticiones de extensiones sin activación', async () => {
      const res = await client
        .get('/api/chats')
        .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('activarse');
    });
  });

  describe('GET /api/chats/:id/mensajes', () => {
    it('devuelve 400 si el id esta vacio', async () => {
      const res = await client.get('/api/chats/%20/mensajes');
      expect(res.status).toBe(400);
    });

    it('rechaza chats individuales', async () => {
      const res = await client.get('/api/chats/5491111111111@s.whatsapp.net/mensajes');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('grupales');
    });
    it('devuelve 200 y array para un id valido', async () => {
      const res = await client.get('/api/chats/120363000000000@g.us/mensajes');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/chats/:id/mensajes/latest', () => {
    it('devuelve 200 y array cuando no hay since', async () => {
      const res = await client.get('/api/chats/120363000000000@g.us/mensajes/latest?since=');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/mensajes/changes', () => {
    it('requiere un cursor ISO para sincronización incremental', async () => {
      const res = await client.get('/api/mensajes/changes');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('since');
    });
  });
  describe('POST /api/chat/summary y /api/chat/reply', () => {
    it('rechaza generación de IA para chats individuales', async () => {
      const individualChatId = '5491111111111@s.whatsapp.net';
      const [summaryResponse, replyResponse] = await Promise.all([
        client.post('/api/chat/summary').send({ chatId: individualChatId }),
        client.post('/api/chat/reply').send({ chatId: individualChatId }),
      ]);

      expect(summaryResponse.status).toBe(400);
      expect(summaryResponse.body.error).toContain('grupales');
      expect(replyResponse.status).toBe(400);
      expect(replyResponse.body.error).toContain('grupales');
    });
  });
  describe('POST /api/enviar', () => {
    it('devuelve 400 si falta chatId o texto', async () => {
      const res = await client.post('/api/enviar').send({ chatId: '', texto: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /webhook/evolution', () => {
    it('devuelve 200 para un evento de mensaje', async () => {
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
});
