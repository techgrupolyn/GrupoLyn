// N-1.0 · cada llamada de Netelip queda asociada a su lead de «Contacto de Reforma»: cruce por teléfono y por email, varias coincidencias a mano,
// repaso del histórico, asignación manual y lo que ve el Historial de llamadas. Postgres en memoria y ClickUp falso: sin red ni escrituras reales.
import express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickUpClient } from '../netelip/captacion/clickup.ts';
import { CAPTACION_TABLES, ensureCaptacion } from '../netelip/captacion/schema.ts';
import { coincidenciasDeLlamada, type LeadCandidato } from '../netelip/captacion/vinculacion.ts';
import { VinculadorLlamadas, leadsParaVinculo, vincularLlamadas, type LeadVinculo } from '../netelip/captacion/vinculo-llamadas.ts';
import { resumenVinculo } from '../netelip/captacion/vinculo-cli.ts';
import { createNetelipWorkers } from '../netelip/index.ts';
import { registerNetelipCalls } from '../netelip/routes.ts';
import { ensureNetelipCalls } from '../netelip/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { levantarClickUpFalso, LISTA_FALSA, TOKEN_FALSO, type ClickUpFalso } from './helpers/clickup-falso.ts';

const lead = (id: string, telefono: string | null, email: string | null = null, esTareaPadre = true): LeadCandidato => ({ clickupTaskId: id, esTareaPadre, telefono, email });

describe('coincidenciasDeLlamada', () => {
  it('por teléfono, con cualquiera de los formatos de Netelip y del formulario', () => {
    const leads = [lead('A', '+34 638 82 92 13'), lead('B', '600111222')];
    for (const tel of ['+34638829213', '638829213', '34638829213', '0034638829213']) expect(coincidenciasDeLlamada({ telefono: tel }, leads), tel).toEqual({ via: 'telefono', ids: ['A'] });
  });

  it('devuelve todas las tarjetas que coinciden, sin repetir una', () => {
    const leads = [lead('A', '+34600111222'), lead('B', '600 111 222'), lead('A', '+34600111222')];
    expect(coincidenciasDeLlamada({ telefono: '+34600111222' }, leads)).toEqual({ via: 'telefono', ids: ['A', 'B'] });
  });

  it('si el teléfono no coincide con ninguna, prueba por email (sin distinguir mayúsculas); si coincide, no mira el email', () => {
    const leads = [lead('A', '+34600111222', 'ana@correo.es'), lead('B', '+34611000111', 'otro@correo.es')];
    expect(coincidenciasDeLlamada({ telefono: '+34699999999', email: 'ANA@correo.es' }, leads)).toEqual({ via: 'email', ids: ['A'] });
    expect(coincidenciasDeLlamada({ telefono: '+34611000111', email: 'ana@correo.es' }, leads)).toEqual({ via: 'telefono', ids: ['B'] });
  });

  it('ninguna coincidencia, número oculto sin email y subtareas: null', () => {
    expect(coincidenciasDeLlamada({ telefono: '+34600000000' }, [lead('A', '+34611111111')])).toBeNull();
    expect(coincidenciasDeLlamada({ telefono: null, email: null }, [lead('A', '+34611111111')])).toBeNull();
    expect(coincidenciasDeLlamada({ telefono: '+34611111111' }, [lead('A', '+34611111111', null, false)])).toBeNull();
  });
});

describe('esquema', () => {
  it('la tabla del cruce está entre las que declara el módulo', () => {
    expect(CAPTACION_TABLES).toContain('captacion_llamada_lead');
  });
});

describe('informe del repaso', () => {
  it('lleva solo totales', () => {
    const t = resumenVinculo({ revisadas: 10, vinculadas: 6, variasCoincidencias: 1, sinCoincidencia: 2, sinDatos: 1 }, { vinculada: 6, varias_coincidencias: 1 });
    expect(t).toBe(
      'Llamadas revisadas en esta pasada: 10 · asociadas a su lead: 6 · con varias coincidencias (a asignar a mano): 1 · sin coincidencia: 2 · sin teléfono ni email: 1\n'
      + 'Estado total de las llamadas: vinculadas 6 · varias coincidencias 1 · sin coincidencia 0 · sin datos 0',
    );
  });
});

describe.skipIf(!hayBaseDePruebas)('cruce de llamadas con leads, de punta a punta', () => {
  let base: BaseAislada;
  let pool: Pool;
  let falso: ClickUpFalso;
  let cliente: ClickUpClient;
  let app: express.Express;

  beforeEach(async () => {
    base = await abrirBaseAislada();
    pool = { query: (sql: string, params?: unknown[]) => base.query(sql, params), connect: async () => ({ query: (sql: string, params?: unknown[]) => base.query(sql, params), release: () => undefined }) } as unknown as Pool;
    await base.exec(`
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre TEXT, apellido TEXT);
      CREATE TABLE clientes (id VARCHAR(255) PRIMARY KEY, nombre TEXT, apellido TEXT, email VARCHAR(255));
      CREATE TABLE crm_leads (id UUID PRIMARY KEY, name TEXT, email VARCHAR(255), phone VARCHAR(80), client_id VARCHAR(255));
    `);
    await ensureNetelipCalls(pool);
    await ensureCaptacion(pool);
    falso = await levantarClickUpFalso();
    cliente = new ClickUpClient({ token: TOKEN_FALSO, listaId: LISTA_FALSA, baseUrl: falso.base, pausaMs: 0, esperar: async () => undefined });
    app = express();
    app.use(express.json());
    registerNetelipCalls(app, {
      pool, kick: () => undefined, env: {},
      // La «sesión»: el rol y el usuario salen de cabeceras de prueba.
      admin: (req, res, next) => {
        if (!req.header('x-rol')) return void res.status(401).json({ error: 'sin sesión' });
        res.locals.rol = req.header('x-rol');
        next();
      },
      role: (res) => String(res.locals.rol),
      actor: () => ({ id: '77', nombre: 'Ernesto' }),
    });
  });
  afterEach(async () => {
    await falso.cerrar();
    await base.cerrar();
  });

  const ERNESTO = { 'x-rol': 'employee:director' };
  const llamada = async (externa: string, telefono: string | null, ocurrida = new Date().toISOString(), crmLeadId: string | null = null): Promise<string> => {
    const r = await base.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, lead_id, duration_seconds, call_status, received_at)
       VALUES ($1, 'outbound', $2, 'uniqueid', $3, $4, $5, $6, 120, 'ANSWERED', now()) RETURNING id`,
      [externa, ocurrida, telefono ?? 'anonymous', telefono, telefono ? 'unknown' : 'hidden', crmLeadId],
    );
    return String(r.rows[0]!.id);
  };
  const vinculo = async (id: string) => (await base.query('SELECT * FROM captacion_llamada_lead WHERE call_id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
  const vl = (id: string, nombre: string, telefono: string | null, email: string | null = null): LeadVinculo => ({ ...lead(id, telefono, email), nombre });

  it('Escenario «Llamada a un lead del formulario»: el teléfono guardado con espacios y la llamada con «00» y prefijo son la misma persona', async () => {
    const id = await llamada('u1', '+34638829213');
    const r = await vincularLlamadas(pool, [vl('T1', 'Ana Beltrán', '638 82 92 13')]);
    expect(r).toMatchObject({ revisadas: 1, vinculadas: 1 });
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T1', lead_nombre: 'Ana Beltrán', via: 'telefono', origen: 'automatico' });
  });

  it('Escenario «Coincidencia por email»: sin coincidencia por teléfono, usa el email de la ficha del Dashboard', async () => {
    await base.query("INSERT INTO crm_leads (id, name, email) VALUES ('11111111-1111-1111-1111-111111111111', 'Ficha', ' Ana@Correo.es ')");
    const id = await llamada('u1', '+34699999999', undefined, '11111111-1111-1111-1111-111111111111');
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600000000', 'ana@correo.es')]);
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T1', via: 'email' });
  });

  it('Escenario «Varias coincidencias»: no se asigna sola y quedan las tarjetas entre las que elegir', async () => {
    const id = await llamada('u1', '+34600111222');
    const r = await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222'), vl('T2', 'Ana (duplicada)', '600 111 222'), vl('T3', 'Otro', '+34611000000')]);
    expect(r).toMatchObject({ variasCoincidencias: 1, vinculadas: 0 });
    const f = await vinculo(id);
    expect(f).toMatchObject({ estado: 'varias_coincidencias', clickup_task_id: null, via: null });
    expect(f!.candidatos).toEqual([{ id: 'T1', nombre: 'Ana' }, { id: 'T2', nombre: 'Ana (duplicada)' }]);
  });

  it('número oculto: «sin datos»; teléfono que no está en ClickUp: «sin coincidencia»', async () => {
    const oculta = await llamada('u1', null);
    const desconocida = await llamada('u2', '+34677777777');
    const r = await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222')]);
    expect(r).toMatchObject({ sinDatos: 1, sinCoincidencia: 1 });
    expect(await vinculo(oculta)).toMatchObject({ estado: 'sin_datos' });
    expect(await vinculo(desconocida)).toMatchObject({ estado: 'sin_coincidencia' });
  });

  it('Escenario «Lead que entra hoy»: la llamada que no coincidía se asocia en cuanto el lead existe, sin carga manual', async () => {
    const id = await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, []);
    expect(await vinculo(id)).toMatchObject({ estado: 'sin_coincidencia' });
    await vincularLlamadas(pool, [vl('T9', 'Lead nuevo', '+34600111222')]);
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T9' });
  });

  it('una llamada ya vinculada no se vuelve a tocar, aunque luego aparezca otro lead con el mismo teléfono', async () => {
    const id = await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222')]);
    const antes = await vinculo(id);
    const r = await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222'), vl('T2', 'Duplicada', '+34600111222')]);
    expect(r.revisadas).toBe(0);
    expect(await vinculo(id)).toEqual(antes);
  });

  it('sin cambios, la fila ni se reescribe (la fecha de actualización no se mueve)', async () => {
    const id = await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, []);
    await base.query("UPDATE captacion_llamada_lead SET actualizado_en = '2026-01-01T00:00:00Z' WHERE call_id = $1", [id]);
    await vincularLlamadas(pool, []);
    expect(new Date((await vinculo(id))!.actualizado_en as string).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('Escenario «Llamadas antiguas»: la pasada normal solo re-mira los últimos 30 días; el repaso mira todas', async () => {
    const vieja = await llamada('u1', '+34600111222', new Date(Date.now() - 40 * 86_400_000).toISOString());
    const reciente = await llamada('u2', '+34600111223');
    await vincularLlamadas(pool, []);
    // El lead de la llamada vieja se crea DESPUÉS de la primera lectura: solo el repaso, que relee ClickUp, lo ve.
    falso.tareas = [{ id: 'T2', nombre: 'Reciente', telefono: '+34600111223', etapa: 0 }];
    const v = new VinculadorLlamadas({ pool, cliente });
    expect(await v.ejecutar()).toMatchObject({ revisadas: 1, vinculadas: 1 });
    expect(await vinculo(vieja)).toMatchObject({ estado: 'sin_coincidencia' });
    expect(await vinculo(reciente)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T2' });
    falso.tareas = [{ id: 'T1', nombre: 'Vieja', telefono: '+34600111222', etapa: 0 }, { id: 'T2', nombre: 'Reciente', telefono: '+34600111223', etapa: 0 }];
    expect(await v.repasarTodo()).toMatchObject({ revisadas: 1, vinculadas: 1 });
    expect(await vinculo(vieja)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T1' });
  });

  it('el cruce solo LEE ClickUp (ninguna petición que no sea GET) y cuenta también las tarjetas cerradas; las subtareas no', async () => {
    const id = await llamada('u1', '+34600111222');
    const cerrada = await llamada('u2', '+34600111223');
    const deSubtarea = await llamada('u3', '+34600111224');
    falso.tareas = [
      { id: 'T1', nombre: 'Abierta', telefono: '+34600111222', etapa: 0 },
      { id: 'T2', nombre: 'Perdida', telefono: '+34600111223', etapa: 4, cerrada: true },
      { id: 'T3', nombre: 'Subtarea', telefono: '+34600111224', etapa: 0, padre: 'T1' },
    ];
    await new VinculadorLlamadas({ pool, cliente }).ejecutar();
    expect(falso.peticiones.filter((p) => p.metodo !== 'GET')).toEqual([]);
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T1' });
    expect(await vinculo(cerrada)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T2' });
    expect(await vinculo(deSubtarea)).toMatchObject({ estado: 'sin_coincidencia' });
  });

  it('el vinculador reutiliza los leads leídos durante 5 minutos y los relee después', async () => {
    falso.tareas = [{ id: 'T1', nombre: 'Ana', telefono: '+34600111222', etapa: 0 }];
    let ahora = 1_000_000;
    const v = new VinculadorLlamadas({ pool, cliente, ahora: () => ahora });
    const lecturas = () => falso.peticiones.filter((p) => p.metodo === 'GET' && p.ruta.includes('/task')).length;
    await v.ejecutar();
    const primera = lecturas();
    expect(primera).toBeGreaterThan(0);
    await v.ejecutar();
    expect(lecturas()).toBe(primera);
    ahora += 4 * 60_000;
    await v.ejecutar();
    expect(lecturas()).toBe(primera);
    ahora += 2 * 60_000;
    await v.ejecutar();
    expect(lecturas()).toBeGreaterThan(primera);
  });

  it('leadsParaVinculo toma las tarjetas padre de cualquier fase', () => {
    const t = (id: string, esPadre: boolean) => ({ id, nombre: `n${id}`, esPadre, estado: '', cerrada: false, creadaEn: 0, campos: { contact_phone_number: '+34600000001' } });
    expect(leadsParaVinculo([t('1', true), t('2', false)])).toEqual([{ clickupTaskId: '1', esTareaPadre: true, telefono: '+34600000001', email: null, nombre: 'n1' }]);
  });

  // --- Lo que ve el Historial de llamadas ---------------------------------------------------------------------------------------

  it('Escenario «Aparece asociada a ese lead»: el listado trae el lead de ClickUp y deja de contar como «sin contacto identificado»', async () => {
    await llamada('u1', '+34600111222');
    await llamada('u2', '+34677777777');
    await vincularLlamadas(pool, [vl('abc123', 'Ana Beltrán', '+34600111222')]);
    const r = await request(app).get('/api/netelip/calls').set(ERNESTO);
    expect(r.status).toBe(200);
    expect(r.body.metrics).toMatchObject({ calls: 2, unidentified: 1 });
    const conLead = r.body.items.find((i: { phone: string }) => i.phone === '+34600111222');
    expect(conLead.captacion).toEqual({ status: 'vinculada', via: 'telefono', task_id: 'abc123', name: 'Ana Beltrán', url: 'https://app.clickup.com/t/abc123' });
    const sin = r.body.items.find((i: { phone: string }) => i.phone === '+34677777777');
    expect(sin.captacion).toEqual({ status: 'sin_coincidencia' });
    const identificadas = await request(app).get('/api/netelip/calls?contact=identified').set(ERNESTO);
    expect(identificadas.body.total).toBe(1);
    const noIdentificadas = await request(app).get('/api/netelip/calls?contact=unidentified').set(ERNESTO);
    expect(noIdentificadas.body.total).toBe(1);
    const porNombre = await request(app).get('/api/netelip/calls?q=Beltr').set(ERNESTO);
    expect(porNombre.body.total).toBe(1);
  });

  it('el id de una tarjeta con caracteres raros no genera un enlace', async () => {
    await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, [vl('a/../b', 'Ana', '+34600111222')]);
    const r = await request(app).get('/api/netelip/calls').set(ERNESTO);
    expect(r.body.items[0].captacion).toMatchObject({ status: 'vinculada', url: null });
  });

  it('el detalle de una llamada también trae su lead', async () => {
    const id = await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, [vl('abc123', 'Ana Beltrán', '+34600111222')]);
    const r = await request(app).get(`/api/netelip/calls/${id}`).set(ERNESTO);
    expect(r.body.call.captacion).toMatchObject({ status: 'vinculada', task_id: 'abc123', name: 'Ana Beltrán' });
  });

  // --- Lista de varias coincidencias y asignación a mano --------------------------------------------------------------------------

  async function conVarias(): Promise<string> {
    const id = await llamada('u1', '+34600111222');
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222'), vl('T2', 'Ana duplicada', '+34600111222')]);
    return id;
  }

  it('Escenario «Varias coincidencias»: aparece en la lista para asignarla a mano, con los totales por estado', async () => {
    const id = await conVarias();
    await llamada('u2', null);
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222'), vl('T2', 'Ana duplicada', '+34600111222')]);
    const r = await request(app).get('/api/captacion/llamadas/sin-asignar').set(ERNESTO);
    expect(r.status).toBe(200);
    expect(r.body.resumen).toEqual({ vinculadas: 0, varias_coincidencias: 1, sin_coincidencia: 0, sin_datos: 1 });
    expect(r.body.items).toEqual([{
      llamada_id: Number(id), occurred_at: expect.any(String), phone: '+34600111222',
      candidatos: [{ id: 'T1', nombre: 'Ana', url: 'https://app.clickup.com/t/T1' }, { id: 'T2', nombre: 'Ana duplicada', url: 'https://app.clickup.com/t/T2' }],
    }]);
  });

  it('la lista pide sesión con acceso al Historial de llamadas', async () => {
    expect((await request(app).get('/api/captacion/llamadas/sin-asignar')).status).toBe(401);
    expect((await request(app).get('/api/captacion/llamadas/sin-asignar').set({ 'x-rol': 'comercial' })).status).toBe(403);
  });

  it('asignar a mano: la llamada queda vinculada a la tarjeta elegida, con quién la asignó, y el cruce automático ya no la toca', async () => {
    const id = await conVarias();
    const r = await request(app).post(`/api/captacion/llamadas/${id}/asignar`).set(ERNESTO).send({ clickup_task_id: 'T2' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ llamada_id: Number(id), clickup_task_id: 'T2', lead_nombre: 'Ana duplicada', via: 'manual' });
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T2', via: 'manual', origen: 'manual', asignada_por: 'Ernesto', candidatos: [] });
    // Aunque los leads cambien (ya solo hay una tarjeta con ese teléfono), la asignación a mano se respeta.
    await base.query("UPDATE captacion_llamada_lead SET actualizado_en = '2026-01-01T00:00:00Z' WHERE call_id = $1", [id]);
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222')], { reintentarDesde: null });
    expect(await vinculo(id)).toMatchObject({ clickup_task_id: 'T2', origen: 'manual' });
    const lista = await request(app).get('/api/captacion/llamadas/sin-asignar').set(ERNESTO);
    expect(lista.body.items).toEqual([]);
  });

  it('asignar exige permiso de validar, una tarjeta de las coincidencias y una llamada pendiente', async () => {
    const id = await conVarias();
    const ruta = `/api/captacion/llamadas/${id}/asignar`;
    expect((await request(app).post(ruta).set({ 'x-rol': 'superadmin' }).send({})).status).toBe(400);
    expect((await request(app).post(ruta).set({ 'x-rol': 'employee:director' }).send({ clickup_task_id: 'OTRA' })).status).toBe(400);
    expect((await request(app).post('/api/captacion/llamadas/abc/asignar').set(ERNESTO).send({ clickup_task_id: 'T1' })).status).toBe(400);
    expect((await request(app).post('/api/captacion/llamadas/99999/asignar').set(ERNESTO).send({ clickup_task_id: 'T1' })).status).toBe(404);
    // Un rol que ve el Historial pero no valida (se limita la lista con CAPTACION_DECISION_VALIDADORES).
    const restringida = express();
    restringida.use(express.json());
    registerNetelipCalls(restringida, { pool, kick: () => undefined, env: { CAPTACION_DECISION_VALIDADORES: 'employee:ernesto' }, admin: (_q, res, next) => { res.locals.rol = 'employee:director'; next(); }, role: (res) => String(res.locals.rol) });
    expect((await request(restringida).post(ruta).send({ clickup_task_id: 'T1' })).status).toBe(403);
    expect(await vinculo(id)).toMatchObject({ estado: 'varias_coincidencias' });
    // Ya asignada, otra asignación es un conflicto.
    expect((await request(app).post(ruta).set(ERNESTO).send({ clickup_task_id: 'T1' })).status).toBe(200);
    expect((await request(app).post(ruta).set(ERNESTO).send({ clickup_task_id: 'T2' })).status).toBe(409);
  });

  it('asignar vuelve a poner en la cola de la calificación la llamada que se había rendido como «sin lead»', async () => {
    const id = await conVarias();
    await base.query("INSERT INTO captacion_cola (llamada_id, ocurrida_en, estado, sin_lead_veces, motivo) VALUES ($1, now(), 'sin_lead', 3, 'varias_coincidencias')", [id]);
    await request(app).post(`/api/captacion/llamadas/${id}/asignar`).set(ERNESTO).send({ clickup_task_id: 'T1' });
    expect((await base.query('SELECT estado, sin_lead_veces, motivo FROM captacion_cola WHERE llamada_id = $1', [id])).rows[0]).toEqual({ estado: 'pendiente', sin_lead_veces: 0, motivo: null });
  });

  it('una llamada con varias coincidencias se vincula sola si el duplicado desaparece, y deja de listar candidatas', async () => {
    const id = await conVarias();
    await vincularLlamadas(pool, [vl('T1', 'Ana', '+34600111222')]);
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T1', via: 'telefono', candidatos: [] });
  });

  it('una asignación a mano hecha mientras se cruzaba no se pisa', async () => {
    const id = await conVarias();
    // Entre leer las llamadas pendientes y guardar el resultado, alguien asigna la llamada a mano.
    let asignada = false;
    const conCarrera = { query: async (sql: string, params?: unknown[]) => {
      const r = await pool.query(sql, params);
      if (!asignada && /FROM netelip_calls c/.test(sql)) {
        asignada = true;
        await pool.query("UPDATE captacion_llamada_lead SET estado = 'vinculada', clickup_task_id = 'T2', lead_nombre = 'Ana duplicada', via = 'manual', origen = 'manual', candidatos = '[]'::jsonb WHERE call_id = $1", [id]);
      }
      return r;
    } } as unknown as Pool;
    await vincularLlamadas(conCarrera, [vl('T1', 'Ana', '+34600111222')]);
    expect(await vinculo(id)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T2', via: 'manual', origen: 'manual' });
  });
  it('asignar solo reabre las llamadas rendidas como «sin lead»: una ya procesada o en error se queda como está', async () => {
    const id = await conVarias();
    await base.query("INSERT INTO captacion_cola (llamada_id, ocurrida_en, estado, intentos) VALUES ($1, now(), 'error', 3)", [id]);
    await request(app).post(`/api/captacion/llamadas/${id}/asignar`).set(ERNESTO).send({ clickup_task_id: 'T1' });
    expect((await base.query('SELECT estado, intentos FROM captacion_cola WHERE llamada_id = $1', [id])).rows[0]).toEqual({ estado: 'error', intentos: 3 });
  });

  it('el email del cliente del Dashboard también sirve para cruzar la llamada', async () => {
    await base.query("INSERT INTO clientes (id, nombre, email) VALUES ('c1', 'Cliente', 'luis@correo.es')");
    const r = await base.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, client_id, duration_seconds, call_status, received_at)
       VALUES ('u1', 'outbound', now(), 'uniqueid', '+34688888888', '+34688888888', 'matched', 'c1', 120, 'ANSWERED', now()) RETURNING id`,
    );
    await vincularLlamadas(pool, [vl('T7', 'Luis', '+34600000000', 'LUIS@correo.es')]);
    expect(await vinculo(String(r.rows[0]!.id))).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T7', via: 'email' });
  });
  it('el repaso recorre todo el histórico por lotes, sin quedarse en las primeras llamadas', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await llamada(`u${i}`, `+3460011122${i}`));
    falso.tareas = [{ id: 'T4', nombre: 'Última', telefono: '+34600111224', etapa: 0 }];
    const repaso = () => new VinculadorLlamadas({ pool, cliente, loteRepaso: 2 }).repasarTodo();
    expect(await repaso()).toMatchObject({ revisadas: 5, vinculadas: 1, sinCoincidencia: 4 });
    expect(await vinculo(ids[4]!)).toMatchObject({ estado: 'vinculada', clickup_task_id: 'T4' });
    expect((await repaso()).revisadas).toBe(4);
  });

  it('la tabla rechaza estados incoherentes', async () => {
    const id = await llamada('u1', '+34600111222');
    const insertar = (cols: string, vals: string) => base.query(`INSERT INTO captacion_llamada_lead (call_id, ${cols}) VALUES (${id}, ${vals})`);
    await expect(insertar('estado', "'inventado'")).rejects.toThrow();
    await expect(insertar('estado, clickup_task_id, via', "'vinculada', 'T1', 'radio'")).rejects.toThrow();
    await expect(insertar('estado, origen', "'sin_coincidencia', 'otro'")).rejects.toThrow();
    await expect(insertar('estado, clickup_task_id, via', "'vinculada', NULL, NULL")).rejects.toThrow();
    await expect(insertar('estado, clickup_task_id, via', "'sin_coincidencia', 'T1', 'telefono'")).rejects.toThrow();
    await expect(insertar('estado, clickup_task_id, via, origen', "'vinculada', 'T1', 'manual', 'automatico'")).rejects.toThrow();
    await expect(insertar('estado, clickup_task_id, via, origen', "'vinculada', 'T1', 'telefono', 'manual'")).rejects.toThrow();
  });
});


describe('arranque del cruce de llamadas', () => {
  it('los procesos de Netelip se construyen con el cruce apagado, encendido y encendido sin credenciales (sin arrancar nada)', () => {
    const pool = {} as unknown as Pool;
    expect(() => createNetelipWorkers(pool, {})).not.toThrow();
    expect(() => createNetelipWorkers(pool, { CAPTACION_VINCULO_ENABLED: 'true' })).not.toThrow();
    expect(() => createNetelipWorkers(pool, { CAPTACION_VINCULO_ENABLED: 'true', CLICKUP_API_TOKEN: 'pk_x', CAPTACION_CLICKUP_LIST_ID: '1' })).not.toThrow();
  });
});