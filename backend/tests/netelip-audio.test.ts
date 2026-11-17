// Reproducir el audio de una llamada grabada desde la ventana de la transcripción (1an2gnpzyp7).
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { audioContentType, registerNetelipCalls } from '../netelip/routes.ts';

type Fila = { via: string; audio_ref: string | null; deleted: boolean };
const GRABADA: Fila = { via: 'phone', audio_ref: '/APIVoice/Record/2026-11-16/2026_11_16_09_20_00_100_600000000.mp3', deleted: false };
const MP3 = Buffer.from('ID3-audio-de-prueba');

function app({ fila = GRABADA as Fila | null, rol = 'superadmin', env = {} as NodeJS.ProcessEnv,
  vdrive = { download: vi.fn(async () => MP3) } as { download: ReturnType<typeof vi.fn> } | null } = {}) {
  const pool = { query: vi.fn(async (sql: string) => {
    if (sql.includes('netelip_audio_deletion_requests d WHERE d.audio_ref = c.audio_ref')) return { rows: fila ? [fila] : [], rowCount: fila ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  }) } as unknown as Pool;
  const server = express();
  registerNetelipCalls(server, { pool, kick: vi.fn(), admin: (_req, _res, next) => next(), role: () => rol, env, vdrive });
  return { server, vdrive };
}
const audio = (server: express.Express, id = '7') => request(server).get(`/api/netelip/calls/${id}/audio`);

describe('Netelip · audio de la llamada grabada', () => {
  it('sirve el audio de vDrive con la sesión, sin caché y sin exponer la ruta ni las credenciales', async () => {
    const { server, vdrive } = app();
    const res = await audio(server).buffer(true).parse((r, cb) => { const parts: Buffer[] = []; r.on('data', (c: Buffer) => parts.push(c)); r.on('end', () => cb(null, Buffer.concat(parts))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^audio\/mpeg/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(res.body as Buffer, MP3)).toBe(0);
    expect(vdrive!.download).toHaveBeenCalledWith(GRABADA.audio_ref);
    expect(JSON.stringify(res.headers)).not.toContain('APIVoice');
  });

  it('solo lo escucha quien puede leer la transcripción', async () => {
    const { server, vdrive } = app({ rol: 'employee:comercial' });
    expect((await audio(server)).status).toBe(403);
    const lector = app({ rol: 'admin', env: { NETELIP_TRANSCRIPT_READER_ROLES: 'superadmin' } });
    const res = await audio(lector.server);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No tienes permiso para escuchar las llamadas.');
    expect(vdrive!.download).not.toHaveBeenCalled();
    expect(lector.vdrive!.download).not.toHaveBeenCalled();
  });

  it('«Grabación no disponible» si la llamada no se grabó, es de WhatsApp o su audio se borró', async () => {
    for (const fila of [{ ...GRABADA, audio_ref: null }, { ...GRABADA, via: 'whatsapp' }, { ...GRABADA, deleted: true }]) {
      const { server, vdrive } = app({ fila });
      const res = await audio(server);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Grabación no disponible.' });
      expect(vdrive!.download).not.toHaveBeenCalled();
    }
  });

  it('sin vDrive configurado, o si vDrive ya no tiene el fichero, tampoco está disponible', async () => {
    expect((await audio(app({ vdrive: null }).server)).status).toBe(503);
    const noEsta = app({ vdrive: { download: vi.fn(async () => { throw new Error('vDrive descarga: HTTP 404'); }) } });
    expect((await audio(noEsta.server)).status).toBe(404);
    const caido = app({ vdrive: { download: vi.fn(async () => { throw new Error('vDrive descarga: HTTP 500'); }) } });
    const res = await audio(caido.server);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Grabación no disponible.' });
  });

  it('llamada inexistente o identificador no válido', async () => {
    expect((await audio(app({ fila: null }).server)).status).toBe(404);
    expect((await audio(app().server, 'abc')).status).toBe(400);
  });

  it('tipo MIME según la extensión del fichero', () => {
    expect(audioContentType('/a/b.mp3')).toBe('audio/mpeg');
    expect(audioContentType('/a/b.WAV')).toBe('audio/wav');
    expect(audioContentType('/a/b')).toBe('audio/mpeg');
  });
});
