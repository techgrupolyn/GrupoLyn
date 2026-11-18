import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// El webhook de ClickUp montado en el servidor REAL (server.ts): la ruta existe fuera de /api (sin sesión del Dashboard) y
// recibe el cuerpo en bruto aunque después venga el express.json global (la firma se calcula sobre los bytes exactos).
// Solo se envían avisos que se descartan antes de hablar con ClickUp: nunca hay red.
const databaseUrl = process.env.QA_TEST_DATABASE_URL;
const SECRETO = 'secreto-del-servidor-solo-para-pruebas';
const RUTA = '/webhook/clickup/captacion';
const firmar = (cuerpo: string): string => createHmac('sha256', SECRETO).update(cuerpo).digest('hex');

describe.skipIf(!databaseUrl)('captación · webhook de ClickUp en el servidor real', () => {
  let server: typeof import('../server.ts');

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo base local QA');
    process.env.DATABASE_URL = databaseUrl;
    process.env.CEO_SESSION_SECRET = 'captacion-webhook-test-only';
    process.env.SUPABASE_SYNC_ENABLED = 'false';
    process.env.EVOLUTION_BACKGROUND_SYNC_ENABLED = 'false';
    process.env.MEETING_AI_BACKGROUND_ANALYSIS_ENABLED = 'false';
    process.env.CAPTACION_WEBHOOK_ENABLED = 'true';
    process.env.CAPTACION_WEBHOOK_SECRET = SECRETO;
    process.env.CLICKUP_API_TOKEN = 'pk_solo_para_pruebas';
    process.env.CAPTACION_CLICKUP_LIST_ID = '901211441576';
    process.env.CAPTACION_INTEGRATION_USER_ID = '99';
    server = await import('../server.ts');
  }, 60000);

  afterAll(async () => {
    await server?.pool.end();
  });

  // Cuerpo con espacios raros a propósito: si el servidor lo reinterpretara como JSON, la firma dejaría de cuadrar.
  const aviso = '{ "event":"taskUpdated",   "task_id":"abc123",\n "history_items":[ {"field":"custom_field", "user":{"id":99}} ] }';

  it('un aviso con la firma correcta recibe 200 sin sesión del Dashboard', async () => {
    const r = await request(server.app).post(RUTA).set('content-type', 'application/json').set('x-signature', firmar(aviso)).send(aviso);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('con otra firma o sin ella recibe 401, no el 401 de «requiere sesión CEO»', async () => {
    const mala = await request(server.app).post(RUTA).set('content-type', 'application/json').set('x-signature', firmar('otro cuerpo')).send(aviso);
    expect(mala.status).toBe(401);
    expect(mala.text).toBe('');
    const sin = await request(server.app).post(RUTA).set('content-type', 'application/json').send(aviso);
    expect(sin.status).toBe(401);
    expect(sin.text).toBe('');
  });

  it('un cuerpo firmado que no es un aviso de ClickUp recibe 400', async () => {
    const cuerpo = '{"no":"es un aviso"}';
    const r = await request(server.app).post(RUTA).set('content-type', 'application/json').set('x-signature', firmar(cuerpo)).send(cuerpo);
    expect(r.status).toBe(400);
  });

  it('solo existe el POST', async () => {
    expect((await request(server.app).get(RUTA)).status).toBe(404);
  });

  it('la API normal sigue pidiendo sesión (esta ruta no abrió nada más)', async () => {
    const r = await request(server.app).post('/api/captacion-inexistente').set('content-type', 'application/json').send('{"a":1}');
    expect(r.status).toBe(401);
    expect(r.body.error).toContain('sesión CEO');
  });
});
