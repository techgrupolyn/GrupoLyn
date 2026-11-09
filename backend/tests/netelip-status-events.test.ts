// Registro de todas las llamadas de una extensión (NETELIP_REGISTRO_EXTENSIONES) a partir de las
// notificaciones de estado de API Voice. Formato según la documentación de Netelip (índice `call`).
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { InvalidEvent } from '../netelip/events.ts';
import { extensionOf, isStatusNotification, parseStatusEvent, registeredExtensions, summarize } from '../netelip/status-events.ts';
import { registerNetelipCalls } from '../netelip/routes.ts';

const EXT = ['115'];
const call = (over: Record<string, unknown> = {}) => ({
  call: JSON.stringify({ uniqueid: '1762700000.42', src: '4711831338115', dst: '34612345678', userexten: '4711831338115',
    status: 'ring', date: '2026-11-09', time: '10:44:10', type: 'outbound', ...over }),
});
const at = (time: string) => new Date(`2026-11-09T${time}Z`);

describe('Netelip · notificaciones de estado', () => {
  it('lee la extensión del usuario SIP (cuenta + extensión) y solo de las registradas', () => {
    expect(extensionOf('4711831338115', EXT)).toBe('115');
    expect(extensionOf('115', EXT)).toBe('115');
    expect(extensionOf('4711831338109', EXT)).toBeNull();
    expect(registeredExtensions({ NETELIP_REGISTRO_EXTENSIONES: ' 115, abc ,109' })).toEqual(['115', '109']);
    expect(registeredExtensions({})).toEqual([]);
  });

  it('convierte el evento en llamada con hora GMT, dirección y número del cliente', () => {
    expect(parseStatusEvent(call(), EXT)).toEqual({
      uniqueid: '1762700000.42', extension: '115', status: 'ring', at: at('10:44:10'), direction: 'outbound', counterpart: '34612345678', idapivoice: null,
    });
    const inbound = parseStatusEvent(call({ src: '645662088', dst: '34865608343', type: 'inbound', status: 'NOANSWER', idapivoice: '1762.9' }), EXT)!;
    expect(inbound).toMatchObject({ direction: 'inbound', counterpart: '645662088', status: 'noanswer', idapivoice: '1762.9' });
  });

  it('ignora otras extensiones y las llamadas entre extensiones', () => {
    expect(parseStatusEvent(call({ userexten: '4711831338109' }), EXT)).toBeNull();
    expect(parseStatusEvent(call({ dst: '109' }), EXT)).toBeNull();
  });

  it('rechaza eventos sin el formato documentado', () => {
    expect(() => parseStatusEvent(call({ status: 'talking' }), EXT)).toThrow(InvalidEvent);
    expect(() => parseStatusEvent(call({ uniqueid: '' }), EXT)).toThrow(InvalidEvent);
    expect(() => parseStatusEvent(call({ date: '' }), EXT)).toThrow(InvalidEvent);
    expect(() => parseStatusEvent({ call: 'no es json' }, EXT)).toThrow(InvalidEvent);
  });

  it('distingue una notificación de estado de una grabación', () => {
    expect(isStatusNotification(call())).toBe(true);
    expect(isStatusNotification({ callrecording: '{}', call: '{}' })).toBe(false);
    expect(isStatusNotification({ uniqueid: '1' })).toBe(false);
  });
});

describe('Netelip · resultado de la llamada', () => {
  const ev = (status: 'ring' | 'answer' | 'hangup' | 'busy' | 'noanswer' | 'notavailable', time: string) => ({ status, at: at(time) });

  it('contestada: duración desde que se contesta hasta que se cuelga, lleguen en el orden que lleguen', () => {
    expect(summarize([ev('hangup', '10:50:10'), ev('ring', '10:44:00'), ev('answer', '10:44:10')]))
      .toEqual({ result: 'contestada', startedAt: at('10:44:00'), answeredAt: at('10:44:10'), endedAt: at('10:50:10'), durationSeconds: 360 });
  });

  it('sin contestar: colgada, no contestada, ocupado, no disponible o todavía en curso, con duración 0', () => {
    expect(summarize([ev('ring', '10:44:00'), ev('hangup', '10:44:20')])).toMatchObject({ result: 'colgada', durationSeconds: 0 });
    expect(summarize([ev('ring', '10:44:00'), ev('noanswer', '10:44:30'), ev('hangup', '10:44:30')]).result).toBe('no_contestada');
    expect(summarize([ev('busy', '10:44:00')]).result).toBe('ocupado');
    expect(summarize([ev('notavailable', '10:44:00')]).result).toBe('no_disponible');
    expect(summarize([ev('ring', '10:44:00')])).toMatchObject({ result: 'en_curso', endedAt: null });
  });
});

describe('Netelip · receptor de notificaciones de estado', () => {
  function app(env: NodeJS.ProcessEnv) {
    const inbox: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO netelip_inbox')) inbox.push({ kind: String(params[0]), payload: JSON.parse(String(params[1])) });
      return { rows: [{ id: '1' }], rowCount: 1 };
    }) } as unknown as Pool;
    const server = express();
    registerNetelipCalls(server, { pool, kick: vi.fn(), admin: (_req, _res, next) => next(), role: () => 'superadmin',
      env: { NETELIP_WEBHOOK_TOKEN: 'tok', NETELIP_TRUSTED_NETWORKS: '127.0.0.1/32,::1/128', ...env } });
    return { server, inbox };
  }
  const post = (server: express.Express, body: Record<string, string>) =>
    request(server).post('/webhook/netelip/tok/callrecording').type('form').send(new URLSearchParams(body).toString());

  it('guarda en la bandeja los eventos de la extensión registrada', async () => {
    const { server, inbox } = app({ NETELIP_REGISTRO_EXTENSIONES: '115' });
    const res = await post(server, call({ status: 'hangup' }));
    expect(res.status).toBe(200);
    expect(inbox).toEqual([{ kind: 'call_event', payload: expect.objectContaining({ uniqueid: '1762700000.42', extension: '115', status: 'hangup' }) }]);
  });

  it('las demás extensiones, y todo si no hay extensiones registradas, se siguen ignorando', async () => {
    const solo115 = app({ NETELIP_REGISTRO_EXTENSIONES: '115' });
    expect((await post(solo115.server, call({ userexten: '4711831338109' }))).text).toBe('ignored');
    expect(solo115.inbox).toEqual([]);
    const ninguna = app({});
    expect((await post(ninguna.server, call())).text).toBe('ignored');
    expect(ninguna.inbox).toEqual([]);
  });
});
