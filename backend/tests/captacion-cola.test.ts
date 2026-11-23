// Captación ABCD · flujo automático: la cola de llamadas transcritas, el orden, los reintentos, la cola «sin lead» y la escritura en ClickUp.
// Postgres en memoria (esquema propio), ClickUp falso y modelo falso. Sin red ni escrituras reales.
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { ClickUpClient } from '../netelip/captacion/clickup.ts';
import { configColaDesdeEnv, encolarCaptacion, encolarPendientesCaptacion, ProcesadorCola } from '../netelip/captacion/cola.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { createNetelipWorkers } from '../netelip/index.ts';
import { processNextTranscription } from '../netelip/processing.ts';
import { ensureNetelipCalls } from '../netelip/schema.ts';
import type { TranscriptionEngine } from '../netelip/transcription.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { CITA_FECHA, FRASE, RESUMEN_BUENO, salidaModelo, TRANSCRIPCION_CON_FECHA } from './helpers/captacion-llamadas.ts';
import { levantarClickUpFalso, LISTA_FALSA, TOKEN_FALSO, type ClickUpFalso, type TareaFalsa } from './helpers/clickup-falso.ts';

const ETAPA = { en_espera: 0, viabilidad: 1, visita: 2, rechazado: 3, perdido: 4 };

describe('configuración del flujo automático', () => {
  it('viene apagado y escribir en ClickUp es un permiso aparte', () => {
    expect(configColaDesdeEnv({})).toEqual({ activa: false, escribirClickUp: false });
    expect(configColaDesdeEnv({ CAPTACION_WORKER_ENABLED: 'true' })).toEqual({ activa: true, escribirClickUp: false });
    expect(configColaDesdeEnv({ CAPTACION_WORKER_ENABLED: 'true', CAPTACION_ESCRIBIR_CLICKUP: 'true' })).toEqual({ activa: true, escribirClickUp: true });
    expect(configColaDesdeEnv({ CAPTACION_WORKER_ENABLED: '1', CAPTACION_ESCRIBIR_CLICKUP: 'yes' })).toEqual({ activa: false, escribirClickUp: false });
    expect(configColaDesdeEnv({ CAPTACION_ESCRIBIR_CLICKUP: 'true' })).toEqual({ activa: false, escribirClickUp: true });
  });

  it('los procesos de Netelip se construyen con el flujo apagado, encendido y encendido sin credenciales (sin arrancar nada)', () => {
    const pool = {} as unknown as Pool;
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => createNetelipWorkers(pool, {})).not.toThrow();
      expect(() => createNetelipWorkers(pool, { CAPTACION_WORKER_ENABLED: 'true' })).not.toThrow();
      const completo = createNetelipWorkers(pool, { CAPTACION_WORKER_ENABLED: 'true', CLICKUP_API_TOKEN: 'pk_x', CAPTACION_CLICKUP_LIST_ID: '1', GOOGLE_GEMINI_API_KEY: 'k' });
      expect(typeof completo.start).toBe('function');
    } finally {
      aviso.mockRestore();
    }
  });
});

describe.skipIf(!hayBaseDePruebas)('cola de captación, de punta a punta', () => {
  let base: BaseAislada;
  let pool: Pool;
  let falso: ClickUpFalso;
  let cliente: ClickUpClient;
  /** Lo que el modelo falso recibió, por orden. */
  let peticiones: Array<{ interaccion: string; usuario: string }>;
  /** Cómo contesta el modelo falso: por defecto una evaluación correcta; con `fallos` primero falla ese número de veces. */
  let fallos = 0;
  let salida: (interaccion: string) => string;
  let avisos: Array<{ asunto: string; detalle: Record<string, unknown> }>;
  /** Se ejecuta mientras el modelo falso «contesta»: sirve para mirar la cola con la llamada a medias. */
  let alEvaluar: (() => Promise<void>) | null;

  const evaluar = async (_s: string, usuario: string): Promise<RespuestaModelo> => {
    const interaccion = /interaccion_id (\S+)/.exec(usuario)![1]!;
    peticiones.push({ interaccion, usuario });
    await alEvaluar?.();
    if (fallos > 0) {
      fallos -= 1;
      throw new Error('el modelo no contesta');
    }
    return { text: salida(interaccion), model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
  };

  beforeEach(async () => {
    base = await abrirBaseAislada();
    pool = { query: (sql: string, params?: unknown[]) => base.query(sql, params), connect: async () => ({ query: (sql: string, params?: unknown[]) => base.query(sql, params), release: () => undefined }) } as unknown as Pool;
    await base.exec(`
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre TEXT);
      CREATE TABLE clientes (id VARCHAR(255) PRIMARY KEY, nombre TEXT, apellido TEXT);
      CREATE TABLE crm_leads (id UUID PRIMARY KEY, name TEXT);
    `);
    await ensureNetelipCalls(pool);
    await ensureCaptacion(pool);
    falso = await levantarClickUpFalso();
    cliente = new ClickUpClient({ token: TOKEN_FALSO, listaId: LISTA_FALSA, baseUrl: falso.base, pausaMs: 0, esperar: async () => undefined });
    peticiones = [];
    fallos = 0;
    // Por defecto el modelo falso da su evaluación CON decisión: sin ella, el flujo vuelve a pedirla una vez (y los recuentos de llamadas cambian).
    salida = (id) => salidaModelo(id, { decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    avisos = [];
    alEvaluar = null;
  });
  afterEach(async () => {
    await falso.cerrar();
    await base.cerrar();
  });

  const tareas = (...t: TareaFalsa[]) => { falso.tareas = t; };
  const posts = () => falso.peticiones.filter((p) => p.metodo !== 'GET');
  const escribioResumen = () => posts().some((x) => { const v = (x.cuerpo as { value?: unknown }).value; return typeof v === 'string' && v.startsWith('Qué quiere:'); });
  /** Por defecto relee los leads de ClickUp en cada llamada (vigencia 0); con `vigente` usa la vigencia normal de 5 minutos. */
  const procesador = (o: { escribir?: boolean; vigente?: boolean; ahora?: () => number; conexion?: Pool } = {}) => new ProcesadorCola({
    pool: o.conexion ?? pool, cliente, evaluar, escribir: o.escribir ?? false, vigenciaLeadsMs: o.vigente ? undefined : 0, ahora: o.ahora,
    avisar: async (asunto, detalle) => { avisos.push({ asunto, detalle }); },
  });
  const decision = (d: string, motivo = 'presupuesto_suficiente') => ({
    decision: d, motivos: [{ codigo: motivo, cita: FRASE.decisor, texto: null }], excepciones: [], dudas: [], pendiente_ernesto: null,
    proximos_pasos: [{ orden: 1, accion: 'Llamar', cuando: { tipo: 'plazo_guion', valor: 'en una semana' }, canal: 'llamada', que_pedir: null, requiere_ernesto: false, cita: CITA_FECHA }],
  });
  const lecturasDeLeads = () => falso.peticiones.filter((p) => p.metodo === 'GET' && p.ruta.includes('/task')).length;
  const fila = async (id: string) => (await base.query('SELECT * FROM captacion_cola WHERE llamada_id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
  /** Hace que la llamada pueda reclamarse ya (como si hubiera pasado su espera). */
  const venceYa = (id: string) => base.query("UPDATE captacion_cola SET proximo_intento = now() - interval '1 second' WHERE llamada_id = $1", [id]);

  /** Inserta una llamada con su transcripción; `encolar: false` la deja fuera de la cola. */
  const llamada = async (externa: string, telefono: string | null, ocurrida = '2026-11-17T10:00:00Z', o: { segundos?: number; transcrita?: boolean; encolar?: boolean; completada?: string } = {}): Promise<string> => {
    const r = await base.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, duration_seconds, call_status, received_at)
       VALUES ($1, 'outbound', $2, 'uniqueid', $3, $4, 'unknown', $5, 'ANSWERED', now()) RETURNING id`,
      [externa, ocurrida, telefono ?? 'anonymous', telefono, o.segundos ?? 240],
    );
    const id = String(r.rows[0]!.id);
    if (o.transcrita !== false) {
      await base.query(
        'INSERT INTO netelip_call_transcriptions (call_id, status, text, segments, completed_at) VALUES ($1, $2, $3, $4, $5)',
        [id, 'completed', TRANSCRIPCION_CON_FECHA, null, o.completada ?? new Date().toISOString()],
      );
    }
    if (o.encolar !== false) await encolarCaptacion(pool, id);
    return id;
  };

  // --- Encolar -----------------------------------------------------------------------------------------------------------------

  it('encola solo las llamadas transcritas de 60 s o más, y repetir el aviso no las duplica', async () => {
    const buena = await llamada('u1', '+34600000001', undefined, { encolar: false });
    const corta = await llamada('u2', '+34600000001', undefined, { segundos: 59, encolar: false });
    const sinTranscripcion = await llamada('u3', '+34600000001', undefined, { transcrita: false, encolar: false });
    expect(await encolarCaptacion(pool, corta)).toBe(false);
    expect(await encolarCaptacion(pool, sinTranscripcion)).toBe(false);
    expect(await encolarCaptacion(pool, buena)).toBe(true);
    expect(await encolarCaptacion(pool, buena)).toBe(false);
    expect((await base.query('SELECT llamada_id FROM captacion_cola')).rows).toEqual([{ llamada_id: buena }]);
    expect(await fila(buena)).toMatchObject({ estado: 'pendiente', intentos: 0, sin_lead_veces: 0 });
    // La recuperación tampoco recoge la corta ni la que no tiene transcripción.
    expect(await encolarPendientesCaptacion(pool, 2)).toBe(0);
  });

  it('la recuperación encola las transcritas de los últimos días que se quedaron fuera, y las antiguas no', async () => {
    const reciente = await llamada('u1', '+34600000001', undefined, { encolar: false });
    await llamada('u2', '+34600000001', undefined, { encolar: false, completada: '2026-01-01T00:00:00Z' });
    const yaEncolada = await llamada('u3', '+34600000001');
    expect(await encolarPendientesCaptacion(pool, 2)).toBe(1);
    expect(await encolarPendientesCaptacion(pool, 2)).toBe(0);
    expect((await base.query('SELECT llamada_id FROM captacion_cola ORDER BY llamada_id')).rows.map((r) => r.llamada_id).sort()).toEqual([reciente, yaEncolada].sort());
  });

  // --- Procesar ----------------------------------------------------------------------------------------------------------------

  it('procesa una llamada: la vincula con su lead, la califica y guarda resumen y decisión; en simulacro no escribe nada en ClickUp', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    salida = (i) => salidaModelo(i, { resumen: RESUMEN_BUENO, decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', clickup_task_id: 'ana', escritura: 'simulada', motivo: null });
    expect((await base.query('SELECT clickup_task_id FROM lead_criterio_evaluacion WHERE interaccion_id = $1 LIMIT 1', [`netelip:${id}`])).rows).toEqual([{ clickup_task_id: 'ana' }]);
    expect((await base.query('SELECT que_quiere FROM lead_resumen_historial')).rows).toEqual([{ que_quiere: RESUMEN_BUENO.que_quiere }]);
    expect(posts()).toEqual([]);
    expect(await procesador().procesarSiguiente()).toBeNull();
  });

  it('con permiso para escribir, deja la calificación y el resumen en la tarjeta; un lead que ya no está vivo no entra (como en el lote) y no se toca', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.perdido },
    );
    const a = await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    const b = await llamada('u2', '+34600000002', '2026-11-17T11:00:00Z');
    salida = (i) => salidaModelo(i, { resumen: RESUMEN_BUENO, decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    const p = procesador({ escribir: true });
    expect(await p.procesarSiguiente()).toBe('procesada');
    const escritos = posts().map((x) => x.ruta);
    expect(escritos.length).toBeGreaterThan(0);
    expect(escritos.every((r) => r.startsWith('/task/ana/field/'))).toBe(true);
    expect(escribioResumen()).toBe(true);
    expect(await fila(a)).toMatchObject({ estado: 'procesada', escritura: 'escrita' });
    // El lead perdido no está entre los candidatos: su llamada queda sin lead y su tarjeta no se toca.
    const antes = posts().length;
    expect(await p.procesarSiguiente()).toBe('sin_lead');
    expect(posts().length).toBe(antes);
    expect(await fila(b)).toMatchObject({ estado: 'pendiente', sin_lead_veces: 1, clickup_task_id: null });
  });

  it('vaciar procesa todo lo pendiente y dice cuántas; sin trabajo no hace nada', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    expect(await procesador().vaciar()).toBe(0);
    await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    await llamada('u2', '+34600000001', '2026-11-18T10:00:00Z');
    expect(await procesador().vaciar()).toBe(2);
    expect((await base.query("SELECT count(*)::int AS n FROM captacion_cola WHERE estado = 'procesada'")).rows[0]!.n).toBe(2);
  });

  it('procesa por orden de fecha de la llamada aunque se encolaran al revés, y la segunda parte del resumen de la primera', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const tarde = await llamada('u2', '+34600000001', '2026-11-18T10:00:00Z');
    const pronto = await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    salida = (i) => salidaModelo(i, { resumen: RESUMEN_BUENO, decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    expect(await procesador().vaciar()).toBe(2);
    expect(peticiones.map((x) => x.interaccion)).toEqual([`netelip:${pronto}`, `netelip:${tarde}`]);
    expect(peticiones[0]!.usuario).toContain('Resumen anterior del lead: ninguno');
    expect(peticiones[1]!.usuario).toContain('Resumen anterior del lead (actualízalo con esta llamada)');
    expect(peticiones[1]!.usuario).toContain(RESUMEN_BUENO.que_quiere);
  });

  it('entre leads distintos también va por fecha de la llamada, no por orden de llegada', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.viabilidad },
    );
    const tarde = await llamada('u1', '+34600000001', '2026-11-18T10:00:00Z');
    const pronto = await llamada('u2', '+34600000002', '2026-11-17T10:00:00Z');
    expect(await procesador().vaciar()).toBe(2);
    expect(peticiones.map((x) => x.interaccion)).toEqual([`netelip:${pronto}`, `netelip:${tarde}`]);
  });

  // --- Reintentos y cola de errores --------------------------------------------------------------------------------------------

  it('Escenario «Fallo de generación»: reintenta con espera creciente, no vuelve a probar hasta que toca y al tercer fallo pasa a la cola de errores y avisa', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    fallos = 99;
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('reintento');
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', intentos: 1, motivo: 'el modelo no contesta' });
    const espera = Number((await base.query("SELECT extract(epoch FROM proximo_intento - now())::int AS s FROM captacion_cola")).rows[0]!.s);
    expect(espera).toBeGreaterThan(55);
    expect(espera).toBeLessThanOrEqual(60);
    expect(await p.procesarSiguiente()).toBeNull();
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('reintento');
    expect(await fila(id)).toMatchObject({ intentos: 2 });
    const segundaEspera = Number((await base.query('SELECT extract(epoch FROM proximo_intento - now())::int AS s FROM captacion_cola')).rows[0]!.s);
    expect(segundaEspera).toBeGreaterThan(295);
    expect(segundaEspera).toBeLessThanOrEqual(300);
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('error');
    expect(await fila(id)).toMatchObject({ estado: 'error', intentos: 3, motivo: 'el modelo no contesta', clickup_task_id: 'ana' });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.detalle).toMatchObject({ llamada_id: id, intentos: 3 });
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBeNull();
    expect(peticiones).toHaveLength(3);
    // No quedó nada a medias: ni evaluaciones, ni resumen, ni decisión.
    expect((await base.query('SELECT count(*)::int AS n FROM lead_criterio_evaluacion')).rows[0]!.n).toBe(0);
  });

  it('si el modelo contesta sin decisión de pase, la cola se la vuelve a pedir una vez y la decisión se guarda', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    let n = 0;
    salida = (i) => { n += 1; return salidaModelo(i, n === 1 ? {} : { decisionIA: decision('seguimiento', 'quiere_pensarlo') }); };
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(n).toBe(2);
    expect(await fila(id)).toMatchObject({ estado: 'procesada', intentos: 1 });
    expect((await base.query("SELECT decision FROM decision_lead WHERE actor = 'ia'")).rows).toEqual([{ decision: 'seguimiento' }]);
  });

  it('un fallo seguido de un acierto deja la llamada procesada con sus intentos', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    fallos = 1;
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('reintento');
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', intentos: 2, motivo: null });
    expect(avisos).toEqual([]);
  });

  it('una salida del modelo que no cumple el contrato también se reintenta y no guarda nada', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    salida = () => '{"esto no es": "una evaluación"}';
    expect(await procesador().procesarSiguiente()).toBe('reintento');
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', intentos: 1 });
    expect((await base.query('SELECT count(*)::int AS n FROM lead_criterio_evaluacion')).rows[0]!.n).toBe(0);
  });

  it('una llamada reclamada que no terminó (el servicio se cayó) se vuelve a reclamar cuando vence su reserva', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    await base.query("UPDATE captacion_cola SET estado = 'procesando', intentos = 1, proximo_intento = now() + interval '5 minutes'");
    expect(await procesador().procesarSiguiente()).toBeNull();
    await venceYa(id);
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', intentos: 2 });
  });

  // --- Sin lead ----------------------------------------------------------------------------------------------------------------

  it('Escenario «Sin lead»: se vuelve a mirar unas horas después y a la tercera queda en la cola «sin lead», sin llamar al modelo', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34699999999');
    const p = procesador();
    for (let veces = 1; veces < 3; veces++) {
      expect(await p.procesarSiguiente()).toBe('sin_lead');
      expect(await fila(id)).toMatchObject({ estado: 'pendiente', sin_lead_veces: veces, intentos: 0 });
      expect(await p.procesarSiguiente()).toBeNull();
      await venceYa(id);
    }
    expect(await p.procesarSiguiente()).toBe('sin_lead');
    expect(await fila(id)).toMatchObject({ estado: 'sin_lead', sin_lead_veces: 3 });
    expect(String((await fila(id))!.motivo).length).toBeGreaterThan(0);
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBeNull();
    expect(peticiones).toEqual([]);
  });

  it('si el lead se crea después de la llamada, la siguiente mirada la procesa', async () => {
    const id = await llamada('u1', '+34600000001');
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('sin_lead');
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', clickup_task_id: 'ana', sin_lead_veces: 1 });
  });

  it('N-1.0: con varias tarjetas con el mismo teléfono no se procesa sola; asignada a mano, se procesa sobre la tarjeta elegida', async () => {
    tareas({ id: 'ana1', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad }, { id: 'ana2', nombre: 'Ana (duplicada)', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('sin_lead');
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', sin_lead_veces: 1, motivo: 'varias_coincidencias' });
    await base.query(
      "INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen, asignada_por) VALUES ($1, 'vinculada', 'ana2', 'Ana (duplicada)', 'manual', 'manual', 'Ernesto')",
      [id],
    );
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', clickup_task_id: 'ana2' });
    // Una asignación a una tarjeta que ya no está entre los leads vivos no fuerza nada: vuelve el cruce normal.
    const otra = await llamada('u2', '+34600000001', '2026-11-18T10:00:00Z');
    await base.query(
      "INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen) VALUES ($1, 'vinculada', 'borrada', 'X', 'manual', 'manual')",
      [otra],
    );
    expect(await p.procesarSiguiente()).toBe('sin_lead');
  });
  it('N-1.0: si una persona asigna la llamada a mano mientras se mira, no se rinde como «sin lead»: se vuelve a probar ya, con la asignación', async () => {
    tareas({ id: 'ana1', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad }, { id: 'ana2', nombre: 'Ana (duplicada)', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    let hecha = false;
    const conCarrera = {
      query: async (sql: string, params?: unknown[]) => {
        const r = await pool.query(sql, params);
        if (!hecha && /FROM captacion_llamada_lead/.test(sql)) {
          hecha = true;
          await pool.query("INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen) VALUES ($1, 'vinculada', 'ana2', 'Ana (duplicada)', 'manual', 'manual')", [id]);
        }
        return r;
      },
      connect: () => pool.connect(),
    } as unknown as Pool;
    expect(await procesador({ conexion: conCarrera }).procesarSiguiente()).toBe('reintento');
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', sin_lead_veces: 0 });
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', clickup_task_id: 'ana2' });
  });

  it('N-1.0: una asignación a mano a OTRA tarjeta hecha mientras se evalúa no se pisa: no se escribe en ClickUp y la llamada pasa a errores, con aviso', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    alEvaluar = async () => {
      await base.query("INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen) VALUES ($1, 'vinculada', 'otra', 'Otra', 'manual', 'manual')", [id]);
    };
    expect(await procesador({ escribir: true }).procesarSiguiente()).toBe('error');
    expect(await fila(id)).toMatchObject({ estado: 'error', clickup_task_id: 'ana' });
    expect(String((await fila(id))!.motivo)).toContain('asignó a mano');
    expect(posts()).toEqual([]);
    expect(avisos.map((a) => a.asunto)).toEqual(['Captación: llamada asignada a mano durante su evaluación']);
  });

  it('N-1.0: una asignación a mano que ya estaba al empezar (a una tarjeta que no es lead vivo) no se confunde con una hecha durante la evaluación', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    await base.query("INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen) VALUES ($1, 'vinculada', 'cerrada', 'Cerrada', 'manual', 'manual')", [id]);
    expect(await procesador({ escribir: true }).procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', clickup_task_id: 'ana' });
    expect(avisos).toEqual([]);
  });
  it('N-1.0: asignada a mano a una tarjeta que existe pero ya no es lead vivo, no se evalúa contra OTRO lead con el mismo teléfono: queda sin lead, sin gastar el modelo', async () => {
    tareas(
      { id: 'cerrada', nombre: 'Ana (perdida)', telefono: '+34600000001', etapa: ETAPA.perdido },
      { id: 'ana', nombre: 'Ana (viva)', telefono: '+34600000001', etapa: ETAPA.viabilidad },
    );
    const id = await llamada('u1', '+34600000001');
    await base.query("INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen) VALUES ($1, 'vinculada', 'cerrada', 'Ana (perdida)', 'manual', 'manual')", [id]);
    expect(await procesador({ escribir: true }).procesarSiguiente()).toBe('sin_lead');
    expect(await fila(id)).toMatchObject({ estado: 'sin_lead' });
    expect(String((await fila(id))!.motivo)).toContain('no está vivo');
    expect(peticiones).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('una llamada sin número (oculto) queda sin lead; una grabación sin conversación se cierra sin gastar intentos del modelo', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const oculta = await llamada('u1', null);
    expect(await procesador().procesarSiguiente()).toBe('sin_lead');
    expect(await fila(oculta)).toMatchObject({ estado: 'pendiente', sin_lead_veces: 1 });
    const vacia = await llamada('u2', '+34600000001', '2026-11-17T12:00:00Z');
    await base.query("UPDATE netelip_call_transcriptions SET text = '   ' WHERE call_id = $1", [vacia]);
    expect(await procesador().procesarSiguiente()).toBe('sin_conversacion');
    expect(await fila(vacia)).toMatchObject({ estado: 'sin_conversacion' });
    expect(peticiones).toEqual([]);
  });

  // --- Orden y exclusión -------------------------------------------------------------------------------------------------------

  it('una llamada espera a las anteriores del mismo teléfono: si la primera está en reintento, la segunda no la adelanta; otro teléfono sí sigue', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.viabilidad },
    );
    const a1 = await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    const a2 = await llamada('u2', '+34600000001', '2026-11-18T10:00:00Z');
    const b1 = await llamada('u3', '+34600000002', '2026-11-19T10:00:00Z');
    fallos = 1;
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('reintento');
    expect(await fila(a1)).toMatchObject({ estado: 'pendiente', intentos: 1 });
    // a1 espera su reintento: a2 (mismo teléfono) no puede adelantarla, b1 (otro lead) sí.
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(b1)).toMatchObject({ estado: 'procesada' });
    expect(await p.procesarSiguiente()).toBeNull();
    expect(await fila(a2)).toMatchObject({ estado: 'pendiente', intentos: 0 });
    await venceYa(a1);
    expect(await p.vaciar()).toBe(2);
    expect(peticiones.map((x) => x.interaccion).slice(-2)).toEqual([`netelip:${a1}`, `netelip:${a2}`]);
  });

  // --- ClickUp -----------------------------------------------------------------------------------------------------------------

  it('si ClickUp no contesta al leer los leads, la llamada no gasta intentos y se vuelve a probar en unos minutos', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    falso.fallar = () => true;
    const p = procesador();
    expect(await p.procesarSiguiente()).toBe('esperando_clickup');
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(String((await fila(id))!.motivo)).toContain('ClickUp no disponible');
    expect(await p.procesarSiguiente()).toBeNull();
    expect(await p.vaciar()).toBe(0);
    expect(peticiones).toEqual([]);
    falso.fallar = null;
    await venceYa(id);
    expect(await p.procesarSiguiente()).toBe('procesada');
  });

  it('si la escritura en ClickUp falla, la llamada queda evaluada y la escritura se repara después sin volver a llamar al modelo', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    salida = (i) => salidaModelo(i, { resumen: RESUMEN_BUENO, decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    falso.fallar = (x) => x.metodo === 'POST';
    const p = procesador({ escribir: true });
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ estado: 'procesada', escritura: 'error' });
    expect(String((await fila(id))!.escritura_detalle).length).toBeGreaterThan(0);
    // Aún no toca reintentarlo (15 minutos), aunque ClickUp ya contestara.
    falso.fallar = null;
    expect(await p.reescribirPendientes()).toBe(0);
    expect(await fila(id)).toMatchObject({ escritura: 'error' });
    // Con ClickUp todavía caído, repararlo falla otra vez: no cuenta como escrito y queda para más tarde.
    falso.fallar = (x) => x.metodo === 'POST';
    await base.query("UPDATE captacion_cola SET actualizado_en = now() - interval '20 minutes'");
    expect(await p.reescribirPendientes()).toBe(0);
    expect(await fila(id)).toMatchObject({ escritura: 'error' });
    await base.query("UPDATE captacion_cola SET actualizado_en = now() - interval '20 minutes'");
    falso.fallar = null;
    const consultasAlModelo = peticiones.length;
    expect(await p.reescribirPendientes()).toBe(1);
    expect(await fila(id)).toMatchObject({ estado: 'procesada', escritura: 'escrita', escritura_detalle: null });
    expect(escribioResumen()).toBe(true);
    expect(peticiones).toHaveLength(consultasAlModelo);
    expect(await p.reescribirPendientes()).toBe(0);
  });

  it('si al reparar la escritura el lead ya no está vivo (se ganó o se perdió entre tanto), no se escribe en su tarjeta', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const primera = await llamada('u0', '+34600000001', '2026-11-16T10:00:00Z');
    const id = await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    const p = procesador({ escribir: true });
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(primera)).toMatchObject({ escritura: 'escrita' });
    falso.fallar = (x) => x.metodo === 'POST';
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ escritura: 'error' });
    await base.query("UPDATE captacion_cola SET actualizado_en = now() - interval '20 minutes'");
    falso.fallar = null;
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.perdido });
    const antes = posts().length;
    expect(await p.reescribirPendientes()).toBe(1);
    expect(await fila(id)).toMatchObject({ escritura: 'no_vivo' });
    // La llamada anterior, que sí se escribió, no cambia.
    expect(await fila(primera)).toMatchObject({ escritura: 'escrita' });
    expect(posts().length).toBe(antes);
  });

  it('la reparación solo mira las escrituras fallidas de los últimos dos días', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    falso.fallar = (x) => x.metodo === 'POST';
    const p = procesador({ escribir: true });
    expect(await p.procesarSiguiente()).toBe('procesada');
    falso.fallar = null;
    await base.query("UPDATE captacion_cola SET creado_en = now() - interval '3 days', actualizado_en = now() - interval '3 days'");
    expect(await p.reescribirPendientes()).toBe(0);
    expect(await fila(id)).toMatchObject({ escritura: 'error' });
  });

  // --- Más garantías del procesador ---------------------------------------------------------------------------------------------

  it('encola una llamada de justo 60 s y no una cuya transcripción falló (tampoco la recuperación)', async () => {
    const justa = await llamada('u1', '+34600000001', undefined, { segundos: 60, encolar: false });
    expect(await encolarCaptacion(pool, justa)).toBe(true);
    const fallida = await llamada('u2', '+34600000001', undefined, { encolar: false });
    await base.query("UPDATE netelip_call_transcriptions SET status = 'failed' WHERE call_id = $1", [fallida]);
    expect(await encolarCaptacion(pool, fallida)).toBe(false);
    expect(await encolarPendientesCaptacion(pool, 2)).toBe(0);
  });

  it('mientras se evalúa, la llamada queda reservada unos minutos (si el servicio se cae, otro la recoge después)', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    let visto: Record<string, unknown> | undefined;
    let segundos = 0;
    alEvaluar = async () => {
      visto = await fila(id);
      segundos = Number((await base.query('SELECT extract(epoch FROM proximo_intento - now())::int AS s FROM captacion_cola')).rows[0]!.s);
    };
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(visto).toMatchObject({ estado: 'procesando', intentos: 1 });
    expect(segundos).toBeGreaterThan(540);
    expect(segundos).toBeLessThanOrEqual(600);
  });

  it('lee los leads de ClickUp una sola vez mientras la lectura es reciente (5 minutos) y otra vez cuando caduca', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    for (let n = 1; n <= 4; n++) await llamada(`u${n}`, '+34600000001', `2026-11-1${n}T10:00:00Z`);
    let ahora = 1_000_000;
    const p = procesador({ vigente: true, ahora: () => ahora });
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(lecturasDeLeads()).toBe(1);
    ahora += 4 * 60_000;
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(lecturasDeLeads()).toBe(1);
    ahora += 2 * 60_000;
    expect(await p.procesarSiguiente()).toBe('procesada');
    expect(lecturasDeLeads()).toBe(2);
  });

  it('las subtareas no cuentan como leads: una subtarea con el mismo teléfono no impide vincular la llamada con su tarjeta', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'sub1', nombre: 'Visita técnica', telefono: '+34600000001', etapa: ETAPA.viabilidad, padre: 'ana', presupuestoFormulario: 1 },
    );
    const id = await llamada('u1', '+34600000001');
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(await fila(id)).toMatchObject({ clickup_task_id: 'ana' });
    // Tampoco se siembran datos de la subtarea.
    expect((await base.query("SELECT count(*)::int AS n FROM lead_presupuesto_evento WHERE clickup_task_id = 'sub1'")).rows[0]!.n).toBe(0);
  });

  it('antes de evaluar deja los datos de la tarjeta: el alcance provisional y el rango del formulario como presupuesto', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad, tipoContacto: 0, tipoReforma: 0, presupuestoFormulario: 2 });
    await llamada('u1', '+34600000001');
    salida = (i) => salidaModelo(i, { presupuesto: null, decisionIA: decision('seguimiento', 'quiere_pensarlo') });
    expect((await base.query('SELECT count(*)::int AS n FROM lead_presupuesto_evento')).rows[0]!.n).toBe(0);
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect((await base.query('SELECT count(*)::int AS n FROM lead_presupuesto_evento')).rows[0]!.n).toBe(1);
    expect((await base.query("SELECT count(*)::int AS n FROM lead_criterio_evaluacion WHERE criterio_id = 'alcance' AND origen <> 'llamada'")).rows[0]!.n).toBe(1);
  });

  it('Escenario «Sin decisión en F2»: un lead en F2 o más allá no genera decisión de pase; uno anterior sí', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.visita },
    );
    await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    await llamada('u2', '+34600000002', '2026-11-17T11:00:00Z');
    salida = (i) => salidaModelo(i, { decisionIA: decision('pasar_a_reunion') });
    expect(await procesador().vaciar()).toBe(2);
    expect((await base.query('SELECT lead_id, actor, origen FROM decision_lead')).rows).toEqual([{ lead_id: 'ana', actor: 'ia', origen: 'nuevo' }]);
  });

  it('el nombre del lead se sustituye antes de que la transcripción salga hacia el modelo', async () => {
    tareas({ id: 'ana', nombre: 'Zacarías', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    await base.query("UPDATE netelip_call_transcriptions SET text = text || E'\\n[00:03:00] CLIENTE: Os llama Zacarías otra vez.' WHERE call_id = $1", [id]);
    expect(await procesador().procesarSiguiente()).toBe('procesada');
    expect(peticiones[0]!.usuario).not.toContain('Zacarías');
    expect(peticiones[0]!.usuario).toContain('Os llama');
  });

  it('una llamada no adelanta a otra anterior del mismo teléfono que está en curso (reservada)', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const a1 = await llamada('u1', '+34600000001', '2026-11-17T10:00:00Z');
    const a2 = await llamada('u2', '+34600000001', '2026-11-18T10:00:00Z');
    await base.query("UPDATE captacion_cola SET estado = 'procesando', intentos = 1, proximo_intento = now() + interval '8 minutes' WHERE llamada_id = $1", [a1]);
    expect(await procesador().procesarSiguiente()).toBeNull();
    expect(await fila(a2)).toMatchObject({ estado: 'pendiente', intentos: 0 });
  });

  it('si la transcripción ya no existe (retención) la llamada se cierra como sin conversación, aunque no tenga lead', async () => {
    const id = await llamada('u1', '+34699999999');
    await base.query('DELETE FROM netelip_call_transcriptions WHERE call_id = $1', [id]);
    expect(await procesador().procesarSiguiente()).toBe('sin_conversacion');
    expect(await fila(id)).toMatchObject({ estado: 'sin_conversacion' });
    expect(String((await fila(id))!.motivo)).toContain('ya no existe');
  });

  it('con otro procesador ya trabajando (cerrojo ocupado) no hace nada; si es libre procesa y al terminar libera el cerrojo', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada('u1', '+34600000001');
    const consultas: Array<{ sql: string; params?: unknown[] }> = [];
    const conCerrojo = (libre: boolean) => ({
      query: (sql: string, params?: unknown[]) => base.query(sql, params),
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          consultas.push({ sql, params });
          return sql.includes('pg_try_advisory_lock') ? { rows: [{ ok: libre }] } : base.query(sql, params);
        },
        release: () => undefined,
      }),
    }) as unknown as Pool;
    expect(await procesador({ conexion: conCerrojo(false) }).vaciar()).toBe(0);
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(consultas.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(false);
    consultas.length = 0;
    expect(await procesador({ conexion: conCerrojo(true) }).vaciar()).toBe(1);
    expect(await fila(id)).toMatchObject({ estado: 'procesada' });
    const pedido = consultas.find((c) => c.sql.includes('pg_try_advisory_lock'));
    const liberado = consultas.find((c) => c.sql.includes('pg_advisory_unlock'));
    expect(pedido?.params).toEqual([7102]);
    expect(liberado?.params).toEqual([7102]);
  });

  // --- Enganche con la transcripción -------------------------------------------------------------------------------------------

  it('al terminar la transcripción de una llamada, entra en la cola solo si el flujo está encendido', async () => {
    const motor: TranscriptionEngine = { name: 'falso', transcribe: async () => ({ engine: 'falso', language: 'es', text: 'Hola, quería informarme', segments: null }) };
    const pendiente = async (externa: string): Promise<string> => {
      const r = await base.query<{ id: string }>(
        `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, duration_seconds, call_status, received_at)
         VALUES ($1, 'outbound', now(), 'uniqueid', '+34600000001', '+34600000001', 'unknown', 240, 'ANSWERED', now()) RETURNING id`,
        [externa],
      );
      await base.query("INSERT INTO netelip_call_transcriptions (call_id, status) VALUES ($1, 'pending')", [r.rows[0]!.id]);
      return String(r.rows[0]!.id);
    };
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const antes = process.env.CAPTACION_WORKER_ENABLED;
    try {
      delete process.env.CAPTACION_WORKER_ENABLED;
      const apagada = await pendiente('u1');
      expect(await processNextTranscription(pool, motor)).toBe('completed');
      expect(await fila(apagada)).toBeUndefined();
      process.env.CAPTACION_WORKER_ENABLED = 'true';
      const encendida = await pendiente('u2');
      expect(await processNextTranscription(pool, motor)).toBe('completed');
      expect(await fila(encendida)).toMatchObject({ estado: 'pendiente', intentos: 0 });
    } finally {
      if (antes === undefined) delete process.env.CAPTACION_WORKER_ENABLED;
      else process.env.CAPTACION_WORKER_ENABLED = antes;
      silencio.mockRestore();
    }
  });

  // --- Esquema -----------------------------------------------------------------------------------------------------------------

  it('la tabla solo admite los estados y escrituras previstos', async () => {
    const insertar = (cols: string, vals: string) => base.query(`INSERT INTO captacion_cola (llamada_id, ocurrida_en, ${cols}) VALUES ('x', now(), ${vals})`);
    await expect(insertar('estado', "'inventado'")).rejects.toThrow();
    await expect(insertar('escritura', "'a_medias'")).rejects.toThrow();
    await expect(insertar('intentos', '-1')).rejects.toThrow();
    await expect(insertar('estado, escritura', "'procesada', 'escrita'")).resolves.toBeDefined();
  });
});
