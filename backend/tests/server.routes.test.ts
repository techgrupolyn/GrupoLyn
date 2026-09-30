import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { app, ensureDatabaseSchema, pool, whatsappInbox } from '../server.ts';

const client = request(app);

afterAll(async () => { await pool.end(); });

describe('Server - protección de APIs de extensión', () => {
  it('rechaza el bypass local en producción incluso si está habilitado por error', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_UNAUTHENTICATED_LOCAL_EXTENSION', 'true');
    try {
      const res = await client.get('/api/chats').set('Host', '127.0.0.1:3003');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('activarse');
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
  const accountId = `qa-routes-${randomUUID()}`;
  const chatId = `${accountId}::120363000000000@g.us`;
  let databaseIsolated = false;
  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL || '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
    const isolated = database.pathname.startsWith('/lyn_qa_') || (process.env.CI === 'true' && database.pathname === '/superagente');
    if (!local || !isolated) throw new Error('La prueba webhook requiere una base QA local o la base efímera de CI');
    databaseIsolated = true;
    await ensureDatabaseSchema();
    await pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
  }, 60000);

  afterAll(async () => {
    if (!databaseIsolated) return;
    await pool.query('DELETE FROM grupos WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
  });

  it('acepta y persiste un mensaje una sola vez con el esquema de arranque inicializado', async () => {
    const payload = {
      event: 'MESSAGES_UPSERT',
      instance: accountId,
      data: {
        key: { remoteJid: '120363000000000@g.us', fromMe: false, id: 'msg-1' },
        pushName: 'Participante QA',
        subject: 'Grupo QA',
        message: { conversation: 'Hola' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    const res = await client.post('/webhook/evolution').send(payload).timeout(20000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const duplicate = await client.post('/webhook/evolution').send(payload).timeout(20000);
    expect(duplicate.status).toBe(200);
    expect((await pool.query('SELECT texto,enviado_por_mi FROM mensajes WHERE account_id=$1 AND chat_id=$2', [accountId, chatId])).rows).toEqual([{ texto: 'Hola', enviado_por_mi: false }]);
    expect((await pool.query('SELECT id FROM whatsapp_message_inbox WHERE account_id=$1', [accountId])).rowCount).toBe(0);
  });

  it('no confirma recepción si falla el almacenamiento durable', async () => {
    const accept = vi.spyOn(whatsappInbox, 'accept').mockRejectedValueOnce(new Error('Almacenamiento QA no disponible'));
    try {
      const res = await client.post('/webhook/evolution').send({ event: 'MESSAGES_UPSERT', instance: accountId,
        data: { key: { remoteJid: '120363000000000@g.us', fromMe: false, id: 'msg-failure' }, message: { conversation: 'No confirmar' } } });
      expect(res.status).toBe(500);
      expect(res.body.ok).not.toBe(true);
      expect((await pool.query('SELECT id FROM mensajes WHERE account_id=$1 AND id=$2', [accountId, `${accountId}::msg-failure`])).rowCount).toBe(0);
    } finally { accept.mockRestore(); }
  });
});
