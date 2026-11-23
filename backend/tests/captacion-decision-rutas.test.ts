// N-1.4 · API de la decisión de pase (formulario del SDR, bandeja de Ernesto, confirmar, corregir y acierto) montada en un Express de
// prueba con la base real en local. Sin red ni ClickUp.
import express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionIA } from '../netelip/captacion/decision.ts';
import { registerDecisionPase, puedeValidarDecisiones } from '../netelip/captacion/decision-rutas.ts';
import { llamadaIdDe, registrarDecisionIA } from '../netelip/captacion/decision-repositorio.ts';
import { registrarResumenLlamada, type Db } from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';

describe('quién valida decisiones', () => {
  it('por defecto, los roles que supervisan el calificador; con CAPTACION_DECISION_VALIDADORES, solo los de esa lista', () => {
    for (const rol of ['superadmin', 'admin', 'employee:director', 'Employee:Director_General', 'EMPLOYEE:DIRECTOR']) expect(puedeValidarDecisiones(rol, {}), rol).toBe(true);
    for (const rol of ['comercial', 'employee:sdr', '', undefined, null]) expect(puedeValidarDecisiones(rol, {}), String(rol)).toBe(false);
    const env = { CAPTACION_DECISION_VALIDADORES: ' employee:ernesto , Admin ' };
    expect(puedeValidarDecisiones('employee:ernesto', env)).toBe(true);
    expect(puedeValidarDecisiones('admin', env)).toBe(true);
    expect(puedeValidarDecisiones('superadmin', env)).toBe(false);
  });
});

const PASO = { orden: 1, accion: 'Llamar para pedir el plano', cuando: { tipo: 'fecha_cliente' as const, valor: 'a partir del día 20' }, canal: 'llamada' as const, quePedir: 'el plano', requiereErnesto: false, cita: 'vuelvo el 20' };
const iaDecision = (o: Partial<DecisionIA> = {}): DecisionIA => ({
  decision: 'seguimiento', motivos: [{ codigo: 'falta_dato_cliente', texto: null, cita: 'te mando el plano cuando vuelva de vacaciones' }], excepciones: [], dudas: [], pendienteErnesto: null, proximosPasos: [PASO], ...o,
});

describe.skipIf(!hayBaseDePruebas)('API de la decisión de pase', () => {
  let base: BaseAislada;
  let db: Db;
  let app: express.Express;
  let alRevisar: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    db = base as unknown as Db;
    const pool = { query: (sql: string, p?: unknown[]) => base.query(sql, p), connect: async () => ({ query: (sql: string, p?: unknown[]) => base.query(sql, p), release: () => undefined }) } as unknown as Pool;
    alRevisar = vi.fn(async () => undefined);
    app = express();
    app.use(express.json());
    registerDecisionPase(app, {
      pool,
      // La «sesión»: el rol y el usuario salen de cabeceras de prueba.
      access: (req, res, next) => {
        if (!req.header('x-rol')) return void res.status(401).json({ error: 'sin sesión' });
        res.locals.rol = req.header('x-rol');
        res.locals.uid = req.header('x-uid') ?? '5';
        next();
      },
      role: (res) => String(res.locals.rol),
      actor: (res) => ({ id: String(res.locals.uid), nombre: `Usuario ${res.locals.uid}` }),
      fail: (res, error) => void res.status(500).json({ error: (error as Error).message }),
      canReadTranscripts: (role) => role === 'superadmin',
      env: {},
      alRevisar,
    });
  });
  afterEach(async () => {
    await base.cerrar();
  });

  const SDR = { 'x-rol': 'employee:sdr', 'x-uid': '5' };
  const ERNESTO = { 'x-rol': 'employee:director', 'x-uid': '77' };
  const como = (cabeceras: Record<string, string>) => ({
    get: (ruta: string) => request(app).get(ruta).set(cabeceras),
    post: (ruta: string, cuerpo: unknown = {}) => request(app).post(ruta).set(cabeceras).send(cuerpo as object),
  });

  async function llamadaProcesada(n: number, decision: DecisionIA | null = iaDecision()): Promise<void> {
    const id = llamadaIdDe(n);
    await base.query(
      `INSERT INTO lead_criterio_evaluacion (clickup_task_id, criterio_id, nivel, origen, interaccion_id, fecha_interaccion) VALUES ('T1', 'presupuesto', 'NE', 'llamada', $1, '2026-11-17T10:00:00Z')`,
      [id],
    );
    if (decision) await registrarDecisionIA(db, { leadId: 'T1', llamadaId: id, decision, versionGuion: 1, versionManual: 1, versionPrompt: 'captacion-v5', origen: 'nuevo' });
  }
  const propuesta = (o: Record<string, unknown> = {}) => ({ decision: 'seguimiento', motivo_codigo: 'falta_dato_cliente', dato_cita: 'Dijo que manda el plano al volver', ...o });

  // --- SDR ---------------------------------------------------------------------------------------------------------------

  it('sin sesión no hay nada, y un identificador de llamada que no es un número da 400', async () => {
    expect((await request(app).get('/api/netelip/calls/1/decision')).status).toBe(401);
    expect((await como(SDR).get('/api/netelip/calls/abc/decision')).status).toBe(400);
    expect((await como(SDR).get('/api/netelip/calls/-4/decision')).status).toBe(400);
    expect((await como(SDR).post('/api/netelip/calls/0/decision', propuesta())).status).toBe(400);
  });

  it('Escenario «Propuesta del SDR en el Dashboard General»: abre el detalle, ve la lista de motivos y registra su decisión, el motivo y el dato', async () => {
    await llamadaProcesada(1);
    const ver = await como(SDR).get('/api/netelip/calls/1/decision');
    expect(ver.status).toBe(200);
    expect(ver.headers['cache-control']).toBe('no-store');
    expect(ver.body).toMatchObject({ lead_conocido: true, sdr: null, ia: null, estado: null });
    expect(ver.body.motivos.seguimiento.map((m: { codigo: string }) => m.codigo)).toContain('falta_dato_cliente');

    const r = await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    expect(r.status).toBe(201);
    // El dato es texto de la llamada: sin permiso de transcripciones no sale de nadie, tampoco del propio SDR; con permiso sí.
    expect(r.body.sdr).toMatchObject({ actor: 'sdr', decision: 'seguimiento', motivo_codigo: 'falta_dato_cliente', dato_cita: null, usuario_nombre: 'Usuario 5' });
    const lector = await como({ 'x-rol': 'superadmin', 'x-uid': '1' }).get('/api/netelip/calls/1/decision');
    expect(lector.body.sdr.dato_cita).toBe('Dijo que manda el plano al volver');
  });

  it('el texto libre de un motivo «otro» de la IA tampoco sale sin permiso de transcripciones (el del SDR, que lo escribió una persona, sí)', async () => {
    await llamadaProcesada(1, iaDecision({ motivos: [{ codigo: 'otro', texto: 'El cliente dijo que se muda a Murcia en marzo', cita: 'te mando el plano cuando vuelva de vacaciones' }] }));
    const r = await como(SDR).post('/api/netelip/calls/1/decision', propuesta({ motivo_codigo: 'otro', motivo_texto: 'Quiere esperar' }));
    expect(r.body.ia).toMatchObject({ motivo_codigo: 'otro', motivo_texto: null });
    expect(r.body.sdr).toMatchObject({ motivo_codigo: 'otro', motivo_texto: 'Quiere esperar' });
    const lector = (await como({ 'x-rol': 'superadmin', 'x-uid': '1' }).get('/api/netelip/calls/1/decision')).body;
    expect(lector.ia.motivo_texto).toBe('El cliente dijo que se muda a Murcia en marzo');
  });

  it('Escenario «El SDR no ve a la IA antes de decidir»: la respuesta no lleva la decisión ni los pasos de la IA hasta que registra la suya', async () => {
    await llamadaProcesada(1);
    const antes = await como(SDR).get('/api/netelip/calls/1/decision');
    expect(antes.body.ia).toBeNull();
    expect(JSON.stringify(antes.body)).not.toContain('Llamar para pedir el plano');
    const despues = await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    expect(despues.body.ia).toMatchObject({ actor: 'ia', decision: 'seguimiento', motivo_codigo: 'falta_dato_cliente', proximos_pasos: [{ accion: 'Llamar para pedir el plano' }] });
    expect(despues.body.estado).toBe('pendiente_ernesto');
    // Y a partir de ahí también la ve al abrir el detalle.
    expect((await como(SDR).get('/api/netelip/calls/1/decision')).body.ia).not.toBeNull();
  });

  it('valida lo que manda el SDR: decisión, motivo de la lista (o «otro» con texto) y dato, con mensajes claros y sin guardar nada', async () => {
    await llamadaProcesada(1);
    const casos: Array<[Record<string, unknown>, string]> = [
      [propuesta({ decision: 'esperar' }), 'La decisión debe ser'],
      [propuesta({ motivo_codigo: 'fuera_de_zona' }), 'El motivo debe ser uno de la lista'],
      [propuesta({ motivo_codigo: undefined }), 'El motivo debe ser uno de la lista'],
      [propuesta({ motivo_codigo: 'otro' }), 'hay que escribir cuál'],
      [propuesta({ dato_cita: '   ' }), 'Falta el dato'],
    ];
    for (const [cuerpo, mensaje] of casos) {
      const r = await como(SDR).post('/api/netelip/calls/1/decision', cuerpo);
      expect(r.status, mensaje).toBe(400);
      expect(r.body.error).toContain(mensaje);
    }
    expect(Number((await base.query("SELECT count(*)::int AS n FROM decision_lead WHERE actor = 'sdr'")).rows[0]!.n)).toBe(0);
  });

  it('una llamada sin lead identificado no admite propuesta (409); la segunda propuesta de la misma llamada tampoco (409)', async () => {
    const sin = await como(SDR).post('/api/netelip/calls/9/decision', propuesta());
    expect(sin.status).toBe(409);
    expect(sin.body.error).toContain('todavía no está vinculada a un lead');
    expect((await como(SDR).get('/api/netelip/calls/9/decision')).body).toMatchObject({ lead_conocido: false, sdr: null, ia: null });

    await llamadaProcesada(1);
    expect((await como(SDR).post('/api/netelip/calls/1/decision', propuesta())).status).toBe(201);
    const otra = await como(SDR).post('/api/netelip/calls/1/decision', propuesta({ decision: 'descartar', motivo_codigo: 'cliente_no_sigue' }));
    expect(otra.status).toBe(409);
    expect(otra.body.error).toContain('ya está registrada');
  });

  it('sin permiso para leer transcripciones, las citas literales de la IA no salen (el resto de la decisión sí)', async () => {
    await llamadaProcesada(1);
    const lectura = { 'x-rol': 'superadmin', 'x-uid': '1' };
    const sinPermiso = (await como(SDR).post('/api/netelip/calls/1/decision', propuesta())).body.ia;
    expect(sinPermiso).toMatchObject({ decision: 'seguimiento', motivo_codigo: 'falta_dato_cliente', dato_cita: null });
    expect(sinPermiso.motivos).toEqual([{ codigo: 'falta_dato_cliente', texto: null }]);
    expect(sinPermiso.proximos_pasos[0]).toMatchObject({ accion: 'Llamar para pedir el plano', cita: null });
    const conPermiso = (await como(lectura).get('/api/netelip/calls/1/decision')).body.ia;
    expect(conPermiso.dato_cita).toBe('te mando el plano cuando vuelva de vacaciones');
    expect(conPermiso.proximos_pasos[0].cita).toBe('vuelvo el 20');
  });

  // --- Ernesto -----------------------------------------------------------------------------------------------------------

  it('la bandeja, el detalle, el acierto, confirmar y corregir son solo para quien valida (403 para el resto)', async () => {
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    for (const [metodo, ruta] of [
      ['get', '/api/captacion/decisiones/bandeja'], ['get', '/api/captacion/decisiones/acierto'], ['get', '/api/captacion/decisiones/llamada/1'],
      ['post', '/api/captacion/decisiones/llamada/1/confirmar'], ['post', '/api/captacion/decisiones/llamada/1/corregir'],
    ] as const) {
      const r = await como(SDR)[metodo](ruta);
      expect(r.status, `${metodo} ${ruta}`).toBe(403);
      expect(r.body.error).toBe('No tienes permiso para validar decisiones de pase.');
    }
    expect(Number((await base.query("SELECT count(*)::int AS n FROM decision_lead WHERE actor = 'ernesto'")).rows[0]!.n)).toBe(0);
  });

  it('Escenario «Acuerdo durante el piloto»: el caso aparece en la bandeja con motivo «piloto» y Ernesto lo ve con las dos valoraciones, el resumen y los pasos', async () => {
    await registrarResumenLlamada(db, {
      clickupTaskId: 'T1', interaccionId: 'netelip:0', fechaInteraccion: '2026-11-12T10:00:00.000Z', transcripcion: '', tienePresupuesto: true,
      resumen: { queQuiere: 'Reforma integral', dondeQuedo: 'Cita en oficina', queLoFrena: 'Nada', paraQueLlamarlo: 'Confirmar la cita', fechaPrevista: null, fechaCita: null },
    });
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());

    const lista = await como(ERNESTO).get('/api/captacion/decisiones/bandeja');
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0]).toMatchObject({ llamadaId: 'netelip:1', leadId: 'T1', coincide: true, motivoEscalado: 'piloto', estado: 'pendiente_ernesto', sdr: { decision: 'seguimiento' }, ia: { decision: 'seguimiento' } });

    const d = await como(ERNESTO).get('/api/captacion/decisiones/llamada/1');
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ llamada_id: 'netelip:1', lead_id: 'T1', estado: 'pendiente_ernesto', motivo_escalado: 'piloto', coincide: true, ernesto: null });
    expect(d.body.sdr.decision).toBe('seguimiento');
    expect(d.body.ia.proximos_pasos).toHaveLength(1);
    expect(d.body.resumen).toMatchObject({ que_quiere: 'Reforma integral', donde_quedo: 'Cita en oficina' });
    expect(d.body.motivos.descartar.length).toBeGreaterThan(0);
    expect((await como(ERNESTO).get('/api/captacion/decisiones/llamada/404')).status).toBe(404);
    expect((await como(ERNESTO).get('/api/captacion/decisiones/llamada/xx')).status).toBe(400);
  });

  it('la bandeja pide estado y límite: «revisados» y «todos» filtran, y un valor raro cae en «pendientes»', async () => {
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar');
    await llamadaProcesada(2);
    await como(SDR).post('/api/netelip/calls/2/decision', propuesta());
    const ids = async (q: string) => (await como(ERNESTO).get(`/api/captacion/decisiones/bandeja${q}`)).body.items.map((f: { llamadaId: string }) => f.llamadaId);
    expect(await ids('')).toEqual(['netelip:2']);
    expect(await ids('?estado=revisados')).toEqual(['netelip:1']);
    expect((await ids('?estado=todos')).sort()).toEqual(['netelip:1', 'netelip:2']);
    expect(await ids('?estado=cualquier-cosa')).toEqual(['netelip:2']);
    expect(await ids('?estado=todos&limite=1')).toHaveLength(1);
  });

  it('confirmar: con acuerdo total no hace falta nada más; queda «validada», con el nombre de quien la revisó, y se refleja en la tarjeta', async () => {
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    const r = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'validada', revisado_por: '77', ernesto: { actor: 'ernesto', decision: 'seguimiento', usuario_nombre: 'Usuario 77' } });
    expect(alRevisar).toHaveBeenCalledTimes(1);
    expect(alRevisar).toHaveBeenCalledWith('T1');
    const repetido = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar');
    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toBe('Ese caso ya está revisado.');
    expect(alRevisar).toHaveBeenCalledTimes(1);
  });

  it('Escenario «Discrepancia»: confirmar exige decir con quién (400) y, diciéndolo, se adopta la decisión de esa parte', async () => {
    await llamadaProcesada(1, iaDecision({ decision: 'derivar_partners', motivos: [{ codigo: 'presupuesto_bajo_lyn', texto: null, cita: 'unos treinta mil euros para todo' }] }));
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta({ decision: 'descartar', motivo_codigo: 'presupuesto_insuficiente' }));
    expect((await como(ERNESTO).get('/api/captacion/decisiones/llamada/1')).body).toMatchObject({ coincide: false, motivo_escalado: 'discrepancia' });
    const sin = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar');
    expect(sin.status).toBe(400);
    expect(sin.body.error).toContain('indica con quién estás de acuerdo');
    expect((await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar', { a_favor: 'otro' })).status).toBe(400);
    expect((await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar', { a_favor: 5 })).status).toBe(400);
    expect(alRevisar).not.toHaveBeenCalled();
    const ok = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar', { a_favor: 'ia' });
    expect(ok.status).toBe(200);
    expect(ok.body.ernesto).toMatchObject({ decision: 'derivar_partners', a_favor: 'ia' });
  });

  it('Escenario «Corrección de Ernesto»: sin el dato que cambia su criterio, 400 y no se guarda; con él, «corregida»', async () => {
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    const sin = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/corregir', { decision: 'descartar', motivo_codigo: 'cliente_no_sigue' });
    expect(sin.status).toBe(400);
    expect(sin.body.error).toContain('Falta el dato');
    expect((await como(ERNESTO).get('/api/captacion/decisiones/llamada/1')).body).toMatchObject({ estado: 'pendiente_ernesto', ernesto: null });
    expect(alRevisar).not.toHaveBeenCalled();

    const ok = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/corregir', {
      decision: 'descartar', motivo_codigo: 'cliente_no_sigue', dato_cita: 'Dijo que ya contrató a otra empresa',
      proximos_pasos: [{ accion: 'Cerrar el lead', cuando: { tipo: 'plazo_guion', valor: 'hoy' }, canal: 'llamada' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ estado: 'corregida', ernesto: { decision: 'descartar', motivo_codigo: 'cliente_no_sigue', proximos_pasos: [{ accion: 'Cerrar el lead' }] } });
    // El dato lo ve quien puede leer transcripciones.
    const lector = await como({ 'x-rol': 'superadmin', 'x-uid': '1' }).get('/api/captacion/decisiones/llamada/1');
    expect(lector.body.ernesto.dato_cita).toBe('Dijo que ya contrató a otra empresa');
    expect(alRevisar).toHaveBeenCalledWith('T1');
  });

  it('un caso que no existe da 404 al confirmar o corregir', async () => {
    expect((await como(ERNESTO).post('/api/captacion/decisiones/llamada/404/confirmar')).status).toBe(404);
    expect((await como(ERNESTO).post('/api/captacion/decisiones/llamada/404/corregir', { decision: 'descartar', motivo_codigo: 'cliente_no_sigue', dato_cita: 'x' })).status).toBe(404);
  });

  it('si reflejar la decisión en ClickUp falla, la revisión ya está guardada y la respuesta es correcta', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    alRevisar.mockRejectedValueOnce(new Error('ClickUp respondió 500'));
    await llamadaProcesada(1);
    await como(SDR).post('/api/netelip/calls/1/decision', propuesta());
    const r = await como(ERNESTO).post('/api/captacion/decisiones/llamada/1/confirmar');
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('validada');
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('no se pudo reflejar en ClickUp'), 'ClickUp respondió 500');
    aviso.mockRestore();
  });

  it('Escenario «Medición del acierto»: 10 casos coincidentes revisados, 9 confirmados → 90 % con 10 casos (y el histórico no suma)', async () => {
    for (let n = 1; n <= 10; n++) {
      await llamadaProcesada(n);
      await como(SDR).post(`/api/netelip/calls/${n}/decision`, propuesta());
      if (n <= 9) await como(ERNESTO).post(`/api/captacion/decisiones/llamada/${n}/confirmar`);
      else await como(ERNESTO).post(`/api/captacion/decisiones/llamada/${n}/corregir`, { decision: 'descartar', motivo_codigo: 'cliente_no_sigue', dato_cita: 'Cambió de idea' });
    }
    for (let n = 100; n < 120; n++) {
      await llamadaProcesada(n, null);
      await registrarDecisionIA(db, { leadId: 'T1', llamadaId: llamadaIdDe(n), decision: iaDecision(), versionGuion: 1, versionManual: 1, versionPrompt: 'v', origen: 'historico' });
    }
    const r = await como(ERNESTO).get('/api/captacion/decisiones/acierto');
    expect(r.status).toBe(200);
    expect(r.body.items.find((f: { actor: string }) => f.actor === 'coincidentes')).toEqual({ actor: 'coincidentes', revisados: 10, aciertos: 9, porcentaje: 90 });
  });
});
