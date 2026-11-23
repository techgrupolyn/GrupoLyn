// Rol del superagente consultor_lectura (personas de fuera): Netelip y reuniones en solo lectura. No existe en Club LYN.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { canAccessNetelipCalls, canReadTranscripts, isNetelipReadOnly, registerNetelipCalls } from '../netelip/routes.ts';
import { canSupervise } from '../netelip/calificador/rutas.ts';
import { puedeValidarDecisiones } from '../netelip/captacion/decision-rutas.ts';
import { verifyPassword } from '../contrasenas.ts';
import { esConsultor } from '../rol-consultor.ts';
import { isCeoAdministratorRole, isCeoMeetingAccessRole, isConsultorMeetingRoute } from '../server.ts';
import { desactivarUsuarioConsultor, guardarUsuarioConsultor, listarUsuariosConsultor, UsuarioConsultorInvalido } from '../usuarios-consultor.ts';

describe('consultor_lectura: permisos', () => {
  it('ve Netelip y lee transcripciones, pero es de solo lectura', () => {
    for (const rol of ['consultor_lectura', 'Consultor Lectura']) {
      expect(esConsultor(rol)).toBe(true);
      expect(canAccessNetelipCalls(rol, {})).toBe(true);
      expect(canReadTranscripts(rol, {})).toBe(true);
      expect(isNetelipReadOnly(rol, {})).toBe(true);
    }
    for (const rol of ['superadmin', 'employee:director']) expect(isNetelipReadOnly(rol, {})).toBe(false);
  });

  it('no supervisa ni valida decisiones aunque se añada por error a las listas', () => {
    expect(canSupervise('consultor_lectura', {})).toBe(false);
    expect(canSupervise('consultor_lectura', { CALIFICADOR_SUPERVISOR_ROLES: 'superadmin,consultor_lectura' })).toBe(false);
    expect(puedeValidarDecisiones('consultor_lectura', {})).toBe(false);
    expect(canSupervise('superadmin', {})).toBe(true);
  });

  it('no es administrador ni miembro del equipo interno (protocolos, Club LYN)', () => {
    expect(isCeoAdministratorRole('consultor_lectura')).toBe(false);
    expect(isCeoMeetingAccessRole('consultor_lectura')).toBe(false);
  });

  it('de reuniones solo usa listado, filtros, detalle y grabación (GET)', () => {
    const id = '0f8e2b1c-1111-4222-8333-944455556666';
    for (const ruta of ['/meetings', '/meetings/filter-options', `/meetings/${id}`, `/meetings/${id}/recording`]) expect(isConsultorMeetingRoute('GET', ruta), ruta).toBe(true);
    for (const ruta of ['/meetings/configuration', '/meetings/work-items', '/directory', `/meetings/${id}/actions`]) expect(isConsultorMeetingRoute('GET', ruta), ruta).toBe(false);
    for (const metodo of ['POST', 'PUT', 'DELETE']) expect(isConsultorMeetingRoute(metodo, `/meetings/${id}`)).toBe(false);
  });

  it('las listas de Netelip siguen siendo configurables por entorno', () => {
    expect(canAccessNetelipCalls('consultor_lectura', { NETELIP_ACCESS_ROLES: 'superadmin' })).toBe(false);
    expect(canReadTranscripts('consultor_lectura', { NETELIP_TRANSCRIPT_READER_ROLES: 'superadmin' })).toBe(false);
  });
});

describe('consultor_lectura: API de Netelip', () => {
  function app(rol: string, env: NodeJS.ProcessEnv = {}) {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() } as unknown as Pool;
    const server = express();
    server.use(express.json());
    // `admin` es el middleware de administración del Dashboard: el consultor no lo pasaría. Netelip usa `session`.
    const admin = vi.fn((_req, res) => res.status(403).json({ error: 'No tienes permisos para esta operación' }));
    registerNetelipCalls(server, { pool, kick: vi.fn(), env, admin, session: (_req, res, next) => { res.locals.rol = rol; next(); }, role: (res) => String(res.locals.rol), vdrive: null });
    return { server, pool, admin };
  }

  it('entra con una sesión válida aunque no sea administrador del Dashboard', async () => {
    const { server, admin } = app('consultor_lectura');
    expect((await request(server).get('/api/netelip/calls/filter-options')).status).toBe(200);
    expect(admin).not.toHaveBeenCalled();
    expect((await request(app('employee:pmc_proyectos').server).get('/api/netelip/calls/filter-options')).status).toBe(403);
  });

  it('no escribe nada: se corta antes de tocar la base de datos', async () => {
    const escrituras: Array<[('post' | 'put'), string]> = [
      ['post', '/api/netelip/calls/7/evaluacion/feedback'],
      ['put', '/api/netelip/comerciales/100'],
      ['put', '/api/netelip/extensions/100'],
      ['post', '/api/netelip/calls/7/decision'],
      ['post', '/api/captacion/decisiones/llamada/7/confirmar'],
      ['post', '/api/captacion/decisiones/llamada/7/corregir'],
      ['post', '/api/captacion/llamadas/7/asignar'],
      ['post', '/api/netelip/entrenador/actualizar'],
      ['post', '/api/netelip/entrenador/versiones/1/publicar'],
    ];
    for (const [metodo, ruta] of escrituras) {
      const { server, pool } = app('consultor_lectura');
      const res = await request(server)[metodo](ruta).send({ texto: 'x', nombre: 'x', rol: 'sdr' });
      expect(res.status, ruta).toBe(403);
      expect(res.body.error).toBe('Tu acceso a las llamadas es de solo lectura.');
      expect(pool.query).not.toHaveBeenCalled();
    }
  });

  it('no ve la configuración de comerciales (sus WhatsApp) y la evaluación le dice que no supervisa', async () => {
    const { server } = app('consultor_lectura');
    expect((await request(server).get('/api/netelip/comerciales')).status).toBe(403);
    expect((await request(server).get('/api/netelip/calls/7/evaluacion')).body.can_supervise).toBe(false);
    expect((await request(app('superadmin').server).get('/api/netelip/comerciales')).status).toBe(200);
  });
});

describe('consultor_lectura: alta de usuarios', () => {
  type Fila = { usuario: string; nombre: string | null; rol: string; activo: boolean; auth_provider: string; password_hash?: string };
  function db(filas: Fila[] = []) {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT usuario, nombre, rol, activo, auth_provider')) return { rows: filas.filter((f) => f.usuario === params[0]) };
      if (sql.startsWith('INSERT')) { const f = { usuario: String(params[0]), password_hash: String(params[1]), nombre: String(params[2]), rol: String(params[3]), activo: true, auth_provider: 'local' }; filas.push(f); return { rows: [f] }; }
      if (sql.startsWith('UPDATE usuarios SET nombre')) { const f = filas.find((x) => x.usuario === params[0])!; Object.assign(f, { nombre: params[1], password_hash: params[2], activo: true }); return { rows: [f] }; }
      if (sql.startsWith('UPDATE usuarios SET activo = FALSE')) { filas.find((x) => x.usuario === params[0])!.activo = false; return { rows: [] }; }
      if (sql.includes('WHERE rol = $1')) return { rows: filas.filter((f) => f.rol === params[0]) };
      throw new Error(`SQL inesperado: ${sql}`);
    });
    return { query, filas };
  }
  const entrada = { usuario: 'agencia.ana', nombre: 'Ana (Agencia)', contrasena: 'una-contrasena-larga' };

  it('crea el usuario local con el rol consultor y la contraseña con hash; al repetir, la cambia', async () => {
    const { query, filas } = db();
    expect((await guardarUsuarioConsultor({ query } as never, entrada)).creado).toBe(true);
    expect(filas[0]).toMatchObject({ usuario: 'agencia.ana', rol: 'consultor_lectura', auth_provider: 'local' });
    expect(filas[0].password_hash).not.toContain('una-contrasena-larga');
    expect(verifyPassword('una-contrasena-larga', filas[0].password_hash!)).toBe(true);
    expect((await guardarUsuarioConsultor({ query } as never, { ...entrada, contrasena: 'otra-contrasena-larga' })).creado).toBe(false);
    expect(verifyPassword('otra-contrasena-larga', filas[0].password_hash!)).toBe(true);
  });

  it('nunca toca un usuario que no es consultor (p. ej. el superadmin)', async () => {
    const { query, filas } = db([{ usuario: 'superadmin', nombre: 'Super', rol: 'superadmin', activo: true, auth_provider: 'local' }]);
    await expect(guardarUsuarioConsultor({ query } as never, { ...entrada, usuario: 'superadmin' })).rejects.toThrow(UsuarioConsultorInvalido);
    await expect(desactivarUsuarioConsultor({ query } as never, 'superadmin')).rejects.toThrow(UsuarioConsultorInvalido);
    expect(filas[0]).toMatchObject({ rol: 'superadmin', activo: true });
  });

  it('valida usuario, nombre y contraseña', async () => {
    const { query } = db();
    for (const mal of [{ usuario: 'ana@empresa.test' }, { usuario: 'a' }, { contrasena: 'corta' }, { nombre: ' ' }]) {
      await expect(guardarUsuarioConsultor({ query } as never, { ...entrada, ...mal })).rejects.toThrow(UsuarioConsultorInvalido);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('desactiva y lista', async () => {
    const { query } = db();
    await guardarUsuarioConsultor({ query } as never, entrada);
    expect(await desactivarUsuarioConsultor({ query } as never, 'agencia.ana')).toBe(true);
    expect(await desactivarUsuarioConsultor({ query } as never, 'no-existe')).toBe(false);
    expect(await listarUsuariosConsultor({ query } as never)).toEqual([expect.objectContaining({ usuario: 'agencia.ana', activo: false })]);
  });
});
