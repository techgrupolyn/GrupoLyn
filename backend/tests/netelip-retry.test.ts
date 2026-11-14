// Reintentar transcripciones fallidas desde el Dashboard: rutas con una base de datos simulada.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { registerNetelipCalls } from '../netelip/routes.ts';

const VDRIVE = { NETELIP_VDRIVE_USER: 'u', NETELIP_VDRIVE_APP_PASSWORD: 'p' };

function app(env: NodeJS.ProcessEnv, requeued: number[], role = 'superadmin') {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows: requeued.map((id) => ({ call_id: String(id) })), rowCount: requeued.length };
  }) } as unknown as Pool;
  const kick = vi.fn();
  const server = express();
  server.use(express.json());
  registerNetelipCalls(server, { pool, kick, env, admin: (_req, _res, next) => next(), role: () => role });
  return { server, queries, kick };
}

describe('Netelip · reintentar transcripciones fallidas', () => {
  it('reencola una llamada fallida y despierta la cola', async () => {
    const { server, queries, kick } = app(VDRIVE, [7]);
    const res = await request(server).post('/api/netelip/calls/7/transcription/retry');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ requeued: [7] });
    expect(kick).toHaveBeenCalledTimes(1);
    const update = queries.find((q) => q.sql.includes('UPDATE netelip_call_transcriptions'))!;
    expect(update.sql).toContain("t.status = 'failed'");
    expect(update.sql).toContain("c.via = 'phone'");
    expect(update.sql).toContain('attempts = 0');
    expect(update.params).toEqual([[7]]);
  });

  it('sin vDrive no reencola: el enlace de Netelip ya no existe y volvería a fallar', async () => {
    const { server, queries, kick } = app({}, [7]);
    const res = await request(server).post('/api/netelip/calls/7/transcription/retry');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('vDrive');
    expect(queries).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it('si la llamada no está fallida (o es de WhatsApp), lo dice y no despierta la cola', async () => {
    const { server, kick } = app(VDRIVE, []);
    const res = await request(server).post('/api/netelip/calls/7/transcription/retry');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('No hay transcripciones fallidas');
    expect(kick).not.toHaveBeenCalled();
  });

  it('reencola varias a la vez, sin duplicados y con un máximo', async () => {
    const { server, queries } = app(VDRIVE, [1, 2]);
    const ok = await request(server).post('/api/netelip/transcriptions/retry').send({ call_ids: [1, 2, 2, 'x', -3] });
    expect(ok.status).toBe(202);
    expect(queries.find((q) => q.sql.includes('UPDATE netelip_call_transcriptions'))!.params).toEqual([[1, 2]]);
    expect((await request(server).post('/api/netelip/transcriptions/retry').send({ call_ids: [] })).status).toBe(400);
    expect((await request(server).post('/api/netelip/transcriptions/retry').send({ call_ids: Array.from({ length: 101 }, (_, i) => i + 1) })).status).toBe(400);
  });

  it('solo para quien ve Historial de llamadas', async () => {
    const { server } = app(VDRIVE, [7], 'employee:comercial');
    expect((await request(server).post('/api/netelip/calls/7/transcription/retry')).status).toBe(403);
  });
});
