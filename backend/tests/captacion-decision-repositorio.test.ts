// N-1.4 · Capa de datos de la decisión de pase contra Postgres: esquema, motivos y contexto configurables, propuesta del SDR, decisión de
// la IA, caso de Ernesto (confirmar y corregir), bandeja y acierto. Sin red.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionIA, EntradaDecision, ProximoPaso } from '../netelip/captacion/decision.ts';
import { EntradaInvalida } from '../netelip/captacion/decision.ts';
import {
  acierto, bandeja, CasoNoEncontrado, CasoYaRevisado, cargarContexto, cargarMotivos, confirmarCaso, corregirCaso, decisionFinalDelLead, detalleCaso,
  LlamadaSinLead, llamadaIdDe, reconciliarValidacion, registrarDecisionIA, registrarPropuestaSDR, vistaParaSDR, YaRegistrada,
  type Revisor,
} from '../netelip/captacion/decision-repositorio.ts';
import { recalcularLead, registrarPresupuestoFormulario, registrarResumenLlamada, type Db } from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';

const PASO: ProximoPaso = {
  orden: 1, accion: 'Llamar para pedir el plano', cuando: { tipo: 'fecha_cliente', valor: 'a partir del día 20' }, canal: 'llamada', quePedir: 'el plano', requiereErnesto: false, cita: 'vuelvo el 20',
};
const ia = (o: Partial<DecisionIA> = {}): DecisionIA => ({
  decision: 'seguimiento', motivos: [{ codigo: 'falta_plano', texto: null, cita: 'te mando el plano cuando vuelva de vacaciones' }],
  excepciones: [], dudas: [], pendienteErnesto: null, proximosPasos: [PASO], ...o,
});
const sdr = (o: Partial<EntradaDecision> = {}): EntradaDecision => ({ decision: 'seguimiento', motivoCodigo: 'falta_plano', motivoTexto: null, datoCita: 'Dijo que manda el plano al volver', ...o });
const ERNESTO: Revisor = { usuarioId: '77', usuarioNombre: 'Ernesto' };

describe.skipIf(!hayBaseDePruebas)('decisión de pase contra Postgres', () => {
  let base: BaseAislada;
  let db: Db;
  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    db = base as unknown as Db;
  });
  afterEach(async () => {
    await base.cerrar();
  });
  const contar = async (tabla: string, donde = 'true'): Promise<number> => Number((await base.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla} WHERE ${donde}`)).rows[0]?.n);

  /** Procesa «a mano» una llamada: la deja vinculada a un lead (como hace la captación al evaluarla). */
  async function llamadaDeLead(numero: number, lead = 'T1', fecha = '2026-11-17T10:00:00.000Z'): Promise<string> {
    const id = llamadaIdDe(numero);
    await base.query(
      `INSERT INTO lead_criterio_evaluacion (clickup_task_id, criterio_id, nivel, origen, interaccion_id, fecha_interaccion) VALUES ($1, 'presupuesto', 'NE', 'llamada', $2, $3)`,
      [lead, id, fecha],
    );
    return id;
  }
  const guardarIA = (llamadaId: string, d: DecisionIA = ia(), o: Partial<Parameters<typeof registrarDecisionIA>[1]> = {}) =>
    registrarDecisionIA(db, { leadId: 'T1', llamadaId, decision: d, versionGuion: 1, versionManual: 1, versionPrompt: 'captacion-v5', origen: 'nuevo', ...o });
  const guardarSDR = (llamadaId: string, e: EntradaDecision = sdr()) => registrarPropuestaSDR(db, { llamadaId, entrada: e, usuarioId: '5', usuarioNombre: 'Sara SDR' });
  const caso = async (n: number, d: DecisionIA = ia(), e: EntradaDecision = sdr()): Promise<string> => {
    const id = await llamadaDeLead(n);
    await guardarIA(id, d);
    await guardarSDR(id, e);
    return id;
  };

  // --- Configuración: motivos y contexto ------------------------------------------------------------------------------

  it('trae sembrada la lista de motivos de las cuatro decisiones (provisional) y «otro» no se puede configurar', async () => {
    const m = await cargarMotivos(db);
    for (const d of ['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar'] as const) expect(m[d].length, d).toBeGreaterThan(0);
    expect(m.seguimiento.map((x) => x.codigo)).toContain('falta_plano');
    expect(m.descartar.map((x) => x.codigo)).toContain('presupuesto_insuficiente');
    await expect(base.query("INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (9, 'seguimiento', 'otro', 'Otro', 1)")).rejects.toThrow();
  });

  it('cambiar la lista es publicar una versión nueva: sin desplegar, manda la de mayor versión', async () => {
    await base.query("INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (2, 'seguimiento', 'nuevo_motivo', 'Un motivo nuevo', 1)");
    const m = await cargarMotivos(db);
    expect(m.seguimiento).toEqual([{ codigo: 'nuevo_motivo', etiqueta: 'Un motivo nuevo' }]);
    // Las decisiones sin filas en esa versión quedan vacías, no desaparecen.
    expect(m.descartar).toEqual([]);
  });

  it('los motivos salen en el orden configurado', async () => {
    const m = await cargarMotivos(db);
    expect(m.seguimiento.map((x) => x.codigo)).toEqual(['falta_plano', 'falta_decisor', 'pide_tiempo', 'compra_pendiente', 'sin_respuesta']);
  });

  it('el guion y el manual vigentes son la mayor versión de cada tipo; un guion nuevo no exige desplegar', async () => {
    const v1 = await cargarContexto(db);
    expect(v1.guion.version).toBe(1);
    expect(v1.manual.version).toBe(1);
    expect(v1.manual.texto).toContain('Pendiente de Ernesto');
    expect(v1.manual.texto).toContain('provisional');
    await base.query("INSERT INTO decision_contexto_config (tipo, version, texto) VALUES ('guion', 2, 'GUION v2 de prueba')");
    const v2 = await cargarContexto(db);
    expect(v2.guion).toEqual({ version: 2, texto: 'GUION v2 de prueba' });
    expect(v2.manual.version).toBe(1);
  });

  it('falla con un mensaje claro si falta el manual o el guion', async () => {
    await base.query("DELETE FROM decision_contexto_config WHERE tipo = 'manual'");
    await expect(cargarContexto(db)).rejects.toThrow('Falta el guion o el manual de reglas');
  });

  it('el esquema es idempotente: aplicarlo otra vez no duplica ni pisa la configuración', async () => {
    await base.query("INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (2, 'seguimiento', 'nuevo_motivo', 'Nuevo', 1)");
    await ensureCaptacion(base);
    await ensureCaptacion(base);
    expect(await contar('decision_motivo_config', 'version = 1')).toBe(13);
    expect(await contar('decision_contexto_config')).toBe(2);
    expect((await cargarMotivos(db)).seguimiento).toEqual([{ codigo: 'nuevo_motivo', etiqueta: 'Nuevo' }]);
  });

  // --- Decisión de la IA -------------------------------------------------------------------------------------------------

  it('guarda la decisión de la IA con su motivo principal, sus próximos pasos y las versiones con que decidió', async () => {
    const id = await llamadaDeLead(1);
    await base.query("INSERT INTO decision_contexto_config (tipo, version, texto) VALUES ('guion', 2, 'GUION v2')");
    const ctx = await cargarContexto(db);
    expect(await guardarIA(id, ia({ excepciones: ['descuento'], dudas: ['encaje_incierto'] }), { versionGuion: ctx.guion.version, versionManual: ctx.manual.version })).toBe(true);
    const f = (await base.query('SELECT * FROM decision_lead WHERE llamada_id = $1', [id])).rows[0]!;
    expect(f).toMatchObject({ actor: 'ia', decision: 'seguimiento', motivo_codigo: 'falta_plano', dato_cita: 'te mando el plano cuando vuelva de vacaciones', version_guion: 2, version_manual: 1, version_prompt: 'captacion-v5', origen: 'nuevo' });
    expect(f.excepciones).toEqual(['descuento']);
    expect(f.dudas).toEqual(['encaje_incierto']);
    expect(f.proximos_pasos).toEqual([PASO]);
    expect(f.tipo_caso).toBeNull();
  });

  it('una decisión sin ningún motivo citable se guarda sin motivo principal y con su «Pendiente de Ernesto»', async () => {
    const id = await llamadaDeLead(1);
    await guardarIA(id, ia({ motivos: [], pendienteErnesto: { queDebeDecidir: 'Decidir encaje' } }));
    const f = (await base.query('SELECT motivo_codigo, dato_cita, pendiente_ernesto FROM decision_lead')).rows[0]!;
    expect(f).toMatchObject({ motivo_codigo: null, dato_cita: null, pendiente_ernesto: { queDebeDecidir: 'Decidir encaje' } });
  });

  it('repetir la misma llamada no duplica ni cambia la decisión de la IA', async () => {
    const id = await llamadaDeLead(1);
    expect(await guardarIA(id)).toBe(true);
    expect(await guardarIA(id, ia({ decision: 'descartar' }))).toBe(false);
    expect(await contar('decision_lead')).toBe(1);
    expect((await base.query('SELECT decision FROM decision_lead')).rows[0]!.decision).toBe('seguimiento');
  });

  it('Escenario «Sin acciones automáticas»: guardar la decisión con un próximo paso no crea avisos, tareas ni mensajes ni toca la calificación', async () => {
    const id = await llamadaDeLead(1);
    await guardarIA(id, ia({ proximosPasos: [{ ...PASO, accion: 'Llamar en una semana' }] }));
    expect(await contar('decision_lead')).toBe(1);
    expect(await contar('validacion_decision')).toBe(0);
    expect(await contar('lead_calificacion_historial')).toBe(0);
  });

  it('el esquema exige las versiones del guion y del manual a la IA, y solo ella puede ser histórica', async () => {
    const insertar = (cols: string, vals: string) => base.query(`INSERT INTO decision_lead (lead_id, llamada_id, ${cols}) VALUES ('T1', 'x', ${vals})`);
    await expect(insertar('actor, decision', "'ia', 'seguimiento'")).rejects.toThrow();
    await expect(insertar('actor, decision, motivo_codigo, dato_cita, origen', "'sdr', 'seguimiento', 'falta_plano', 'dato', 'historico'")).rejects.toThrow();
    await expect(insertar('actor, decision, motivo_codigo, dato_cita, origen', "'sdr', 'seguimiento', 'falta_plano', 'dato', 'nuevo'")).resolves.toBeDefined();
    await expect(insertar('actor, decision, motivo_codigo', "'sdr', 'seguimiento', 'falta_plano'")).rejects.toThrow();
    await expect(insertar('actor, decision, dato_cita', "'sdr', 'seguimiento', 'dato'")).rejects.toThrow();
    await expect(insertar('actor, decision, dato_cita, a_favor', "'ernesto', 'seguimiento', 'dato', 'luna'")).rejects.toThrow();
    await expect(insertar('actor, decision, dato_cita, motivo_codigo, a_favor', "'sdr', 'seguimiento', 'dato', 'm', 'ia'")).rejects.toThrow();
    await expect(insertar('actor, decision', "'robot', 'seguimiento'")).rejects.toThrow();
    await expect(insertar('actor, decision, version_guion, version_manual', "'ia', 'esperar', 1, 1")).rejects.toThrow();
  });

  it('el caso de Ernesto: un caso revisado exige revisor y fecha, y el motivo de escalado es uno de los cuatro', async () => {
    const insertar = (cols: string, vals: string) => base.query(`INSERT INTO validacion_decision (llamada_id, lead_id, coincidencia_sdr_ia, ${cols}) VALUES ('x', 'T1', true, ${vals})`);
    await expect(insertar('motivo_escalado, estado', "'piloto', 'validada'")).rejects.toThrow();
    await expect(insertar('motivo_escalado, estado, revisado_por', "'piloto', 'validada', '77'")).rejects.toThrow();
    await expect(insertar('motivo_escalado', "'inventado'")).rejects.toThrow();
    await expect(insertar('motivo_escalado, estado, revisado_por, revisado_en', "'piloto', 'validada', '77', now()")).resolves.toBeDefined();
  });

  // --- Propuesta del SDR -------------------------------------------------------------------------------------------------

  it('Escenario «Propuesta del SDR»: queda guardada con quién la hizo, y la llamada debe estar vinculada a un lead', async () => {
    await expect(guardarSDR(llamadaIdDe(999))).rejects.toThrow(LlamadaSinLead);
    const id = await llamadaDeLead(1);
    const r = await guardarSDR(id, sdr({ decision: 'descartar', motivoCodigo: 'otro', motivoTexto: 'Quiere esperar a la herencia', datoCita: 'Dijo que la herencia tarda un año' }));
    expect(r).toEqual({ leadId: 'T1', motivoEscalado: null });
    const f = (await base.query("SELECT * FROM decision_lead WHERE actor = 'sdr'")).rows[0]!;
    expect(f).toMatchObject({ lead_id: 'T1', llamada_id: id, decision: 'descartar', motivo_codigo: 'otro', motivo_texto: 'Quiere esperar a la herencia', dato_cita: 'Dijo que la herencia tarda un año', usuario_id: '5', usuario_nombre: 'Sara SDR', origen: 'nuevo' });
  });

  it('el SDR registra UNA vez por llamada: la segunda se rechaza y no cambia la primera', async () => {
    const id = await llamadaDeLead(1);
    await guardarSDR(id);
    await expect(guardarSDR(id, sdr({ decision: 'descartar', motivoCodigo: 'no_interesado' }))).rejects.toThrow(YaRegistrada);
    expect(await contar('decision_lead', "actor = 'sdr'")).toBe(1);
    expect((await base.query("SELECT decision FROM decision_lead WHERE actor = 'sdr'")).rows[0]!.decision).toBe('seguimiento');
  });

  it('Escenario «Independencia»: el SDR registra solo lo suyo; la petición al modelo nunca lleva su propuesta (la propuesta no sale de la tabla del SDR)', async () => {
    const id = await llamadaDeLead(1);
    await guardarSDR(id);
    expect(await contar('decision_lead', "actor = 'ia'")).toBe(0);
  });

  // --- Lo que ve el SDR ----------------------------------------------------------------------------------------------------

  it('Escenario «El SDR no ve a la IA antes de decidir»: con la IA ya procesada, sin propuesta del SDR no se ve su decisión ni sus pasos', async () => {
    const id = await llamadaDeLead(1);
    await guardarIA(id);
    const antes = await vistaParaSDR(db, id);
    expect(antes).toMatchObject({ leadConocido: true, sdr: null, ia: null, estado: null });
    expect(JSON.stringify(antes)).not.toContain('Llamar para pedir el plano');
    expect(antes.motivos.seguimiento.length).toBeGreaterThan(0);

    await guardarSDR(id);
    const despues = await vistaParaSDR(db, id);
    expect(despues.sdr).toMatchObject({ decision: 'seguimiento', usuarioNombre: 'Sara SDR' });
    expect(despues.ia).toMatchObject({ decision: 'seguimiento', proximosPasos: [PASO] });
    expect(despues.estado).toBe('pendiente_ernesto');
  });

  it('una llamada sin lead identificado se ve como «lead desconocido»: no se puede registrar nada', async () => {
    expect(await vistaParaSDR(db, llamadaIdDe(5))).toMatchObject({ leadConocido: false, sdr: null, ia: null });
  });

  // --- Comparación y caso de Ernesto ---------------------------------------------------------------------------------------

  it('Escenario «Acuerdo durante el piloto»: coinciden → caso pendiente con motivo «piloto» y dos valoraciones independientes', async () => {
    const id = await caso(1);
    expect(await contar('decision_lead', 'llamada_id = $1'.replace('$1', `'${id}'`))).toBe(2);
    const v = (await base.query('SELECT * FROM validacion_decision')).rows[0]!;
    expect(v).toMatchObject({ llamada_id: id, lead_id: 'T1', coincidencia_sdr_ia: true, motivo_escalado: 'piloto', estado: 'pendiente_ernesto', revisado_por: null, revisado_en: null });
  });

  it('Escenario «Discrepancia»: SDR descarta e IA deriva → pendiente con motivo «discrepancia»', async () => {
    const id = await caso(1, ia({ decision: 'derivar_partners', motivos: [{ codigo: 'presupuesto_partners', texto: null, cita: 'entre uno y dos mil' }] }), sdr({ decision: 'descartar', motivoCodigo: 'presupuesto_insuficiente' }));
    expect((await base.query('SELECT coincidencia_sdr_ia, motivo_escalado, estado FROM validacion_decision WHERE llamada_id = $1', [id])).rows[0]).toEqual({ coincidencia_sdr_ia: false, motivo_escalado: 'discrepancia', estado: 'pendiente_ernesto' });
  });

  it('Escenario «Excepción económica»: coinciden pero el cliente pide un descuento → «excepcion»; una duda → «duda»', async () => {
    await caso(1, ia({ excepciones: ['descuento'] }));
    const id2 = await llamadaDeLead(2);
    await guardarIA(id2, ia({ dudas: ['presupuesto_limite'] }));
    await guardarSDR(id2);
    const id3 = await llamadaDeLead(3);
    await guardarIA(id3, ia({ proximosPasos: [{ ...PASO, requiereErnesto: true }] }));
    await guardarSDR(id3);
    const id4 = await llamadaDeLead(4);
    await guardarIA(id4, ia({ pendienteErnesto: { queDebeDecidir: 'x' } }));
    await guardarSDR(id4);
    const motivos = (await base.query('SELECT llamada_id, motivo_escalado FROM validacion_decision ORDER BY llamada_id')).rows.map((f) => f.motivo_escalado);
    expect(motivos).toEqual(['excepcion', 'duda', 'excepcion', 'duda']);
  });

  it('el caso se crea cuando llega la segunda propuesta, sea cual sea el orden (SDR antes que la IA, o al revés)', async () => {
    const a = await llamadaDeLead(1);
    await guardarSDR(a);
    expect(await contar('validacion_decision')).toBe(0);
    await guardarIA(a);
    expect(await contar('validacion_decision')).toBe(1);

    const b = await llamadaDeLead(2);
    await guardarIA(b);
    expect(await contar('validacion_decision')).toBe(1);
    await guardarSDR(b);
    expect(await contar('validacion_decision')).toBe(2);
  });

  it('reconciliar es seguro: no duplica ni cambia un caso que ya existe, y devuelve su motivo', async () => {
    const id = await caso(1, ia({ excepciones: ['descuento'] }));
    expect(await reconciliarValidacion(db, id)).toBe('excepcion');
    expect(await reconciliarValidacion(db, id)).toBe('excepcion');
    expect(await contar('validacion_decision')).toBe(1);
    expect(await reconciliarValidacion(db, llamadaIdDe(77))).toBeNull();
  });

  it('reconciliar un caso ya creado devuelve el motivo que quedó guardado, no uno recalculado', async () => {
    const id = await caso(1, ia({ excepciones: ['descuento'] }));
    await base.query("UPDATE validacion_decision SET motivo_escalado = 'duda' WHERE llamada_id = $1", [id]);
    expect(await reconciliarValidacion(db, id)).toBe('duda');
    expect((await base.query('SELECT motivo_escalado FROM validacion_decision')).rows[0]!.motivo_escalado).toBe('duda');
  });

  it('una decisión histórica de la calibración no crea caso en la bandeja aunque exista propuesta del SDR', async () => {
    const id = await llamadaDeLead(1);
    await guardarIA(id, ia(), { origen: 'historico' });
    await guardarSDR(id);
    expect(await contar('validacion_decision')).toBe(0);
  });

  // --- Bandeja -------------------------------------------------------------------------------------------------------------

  it('la bandeja lista una fila por caso con las dos propuestas, los pendientes primero y los más antiguos antes', async () => {
    const a = await caso(1);
    const b = await caso(2, ia({ decision: 'descartar', motivos: [{ codigo: 'fuera_de_zona', texto: null, cita: 'vivimos en Madrid capital' }] }));
    const c = await caso(3);
    await base.query("UPDATE validacion_decision SET creado_en = '2026-11-16T09:00:00Z' WHERE llamada_id = $1", [b]);
    await base.query("UPDATE validacion_decision SET creado_en = '2026-11-17T09:00:00Z' WHERE llamada_id = $1", [a]);
    await base.query("UPDATE validacion_decision SET creado_en = '2026-11-18T09:00:00Z' WHERE llamada_id = $1", [c]);
    await confirmarCaso(db, { llamadaId: a, revisor: ERNESTO });
    const pendientes = await bandeja(db);
    expect(pendientes.map((f) => f.llamadaId)).toEqual([b, c]);
    expect(pendientes[0]).toMatchObject({ leadId: 'T1', coincide: false, motivoEscalado: 'discrepancia', estado: 'pendiente_ernesto', sdr: { decision: 'seguimiento', motivoCodigo: 'falta_plano' }, ia: { decision: 'descartar', motivoCodigo: 'fuera_de_zona' }, revisadoEn: null });
    expect(pendientes[0]!.fechaLlamada).toBe('2026-11-17T10:00:00.000Z');
    expect((await bandeja(db, { estado: 'revisados' })).map((f) => [f.llamadaId, f.estado])).toEqual([[a, 'validada']]);
    expect((await bandeja(db, { estado: 'todos' })).map((f) => f.llamadaId)).toEqual([b, c, a]);
  });

  it('la bandeja respeta el límite y no admite valores raros', async () => {
    for (const n of [1, 2, 3]) await caso(n);
    expect(await bandeja(db, { limite: 2 })).toHaveLength(2);
    expect(await bandeja(db, { limite: -5 })).toHaveLength(3);
    expect(await bandeja(db, { limite: 1.5 })).toHaveLength(3);
  });

  it('el detalle del caso trae las tres decisiones, el resumen del lead (N-1.3) y su calificación', async () => {
    await registrarPresupuestoFormulario(db, { clickupTaskId: 'T1', opcion: '40.000 – 100.000 €', fechaInteraccion: '2026-11-10T10:00:00.000Z' });
    await recalcularLead(db, 'T1', { disparador: 'alta', categoriaElegida: 'B' });
    await registrarResumenLlamada(db, {
      clickupTaskId: 'T1', interaccionId: 'netelip:0', fechaInteraccion: '2026-11-12T10:00:00.000Z', transcripcion: '', tienePresupuesto: true,
      resumen: { queQuiere: 'Reforma integral', dondeQuedo: 'Cita en oficina', queLoFrena: 'Nada', paraQueLlamarlo: 'Confirmar la cita', fechaPrevista: null, fechaCita: null },
    });
    const id = await caso(1);
    const d = (await detalleCaso(db, id))!;
    expect(d).toMatchObject({ llamadaId: id, leadId: 'T1', estado: 'pendiente_ernesto', motivoEscalado: 'piloto', coincide: true, ernesto: null, revisadoPor: null });
    expect(d.sdr.decision).toBe('seguimiento');
    expect(d.ia.proximosPasos).toEqual([PASO]);
    expect(d.resumen?.queQuiere).toBe('Reforma integral');
    expect(d.calificacion).toEqual({ categoria: 'B', presupuesto: 70000, ponderado: 52500 });
    expect(d.motivos.seguimiento.length).toBeGreaterThan(0);
    expect(await detalleCaso(db, llamadaIdDe(404))).toBeNull();
  });

  // --- Confirmar -----------------------------------------------------------------------------------------------------------

  it('Ernesto confirma un caso en que SDR e IA coinciden: queda «validada» y su fila (la final) junto a las del SDR y la IA, con los pasos de la IA', async () => {
    const id = await caso(1);
    const fila = await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO });
    expect(fila).toMatchObject({ actor: 'ernesto', decision: 'seguimiento', motivoCodigo: 'falta_plano', aFavor: null, usuarioId: '77', usuarioNombre: 'Ernesto', versionGuion: 1, versionManual: 1, proximosPasos: [PASO] });
    const v = (await base.query('SELECT estado, revisado_por, revisado_en FROM validacion_decision')).rows[0]!;
    expect(v).toMatchObject({ estado: 'validada', revisado_por: '77' });
    expect(v.revisado_en).not.toBeNull();
    expect((await base.query('SELECT actor FROM decision_lead ORDER BY actor')).rows.map((f) => f.actor)).toEqual(['ernesto', 'ia', 'sdr']);
  });

  it('si SDR e IA no coinciden en decisión o en motivo, confirmar exige decir con quién; sin decirlo no se guarda nada', async () => {
    const id = await caso(1, ia({ decision: 'derivar_partners', motivos: [{ codigo: 'presupuesto_partners', texto: null, cita: 'unos treinta mil euros' }] }), sdr({ decision: 'descartar', motivoCodigo: 'presupuesto_insuficiente' }));
    await expect(confirmarCaso(db, { llamadaId: id, revisor: ERNESTO })).rejects.toThrow('indica con quién estás de acuerdo');
    await expect(confirmarCaso(db, { llamadaId: id, revisor: ERNESTO, aFavor: 'nadie' })).rejects.toThrow('«a favor» debe ser sdr o ia');
    expect(await contar('decision_lead', "actor = 'ernesto'")).toBe(0);
    expect((await base.query('SELECT estado FROM validacion_decision')).rows[0]!.estado).toBe('pendiente_ernesto');

    const fila = await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO, aFavor: 'sdr' });
    expect(fila).toMatchObject({ decision: 'descartar', motivoCodigo: 'presupuesto_insuficiente', aFavor: 'sdr', datoCita: 'Dijo que manda el plano al volver' });
  });

  it('con la misma decisión pero otro motivo es una discrepancia: también hay que elegir y se adopta el motivo de quien se elija', async () => {
    const id = await caso(1, ia({ motivos: [{ codigo: 'pide_tiempo', texto: null, cita: 'necesito pensarlo con calma' }] }), sdr({ motivoCodigo: 'falta_plano' }));
    expect((await base.query('SELECT coincidencia_sdr_ia, motivo_escalado FROM validacion_decision')).rows[0]).toEqual({ coincidencia_sdr_ia: false, motivo_escalado: 'discrepancia' });
    expect((await bandeja(db))[0]).toMatchObject({ coincide: false, motivoEscalado: 'discrepancia' });
    await expect(confirmarCaso(db, { llamadaId: id, revisor: ERNESTO })).rejects.toThrow(EntradaInvalida);
    const fila = await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO, aFavor: 'ia' });
    expect(fila).toMatchObject({ decision: 'seguimiento', motivoCodigo: 'pide_tiempo', aFavor: 'ia', datoCita: 'necesito pensarlo con calma' });
  });

  it('si la IA adoptada no tenía ningún dato citado, la confirmación deja constancia sin inventar uno', async () => {
    const id = await caso(1, ia({ motivos: [], pendienteErnesto: { queDebeDecidir: 'x' } }), sdr({ motivoCodigo: 'falta_plano' }));
    const fila = await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO, aFavor: 'ia' });
    expect(fila.datoCita).toBe('Confirmado sin cambios');
    expect(fila.motivoCodigo).toBeNull();
  });

  it('un caso ya revisado no se puede revisar otra vez, y uno que no existe da «no encontrado»', async () => {
    const id = await caso(1);
    await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO });
    await expect(confirmarCaso(db, { llamadaId: id, revisor: ERNESTO })).rejects.toThrow(CasoYaRevisado);
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'x' } })).rejects.toThrow(CasoYaRevisado);
    await expect(confirmarCaso(db, { llamadaId: llamadaIdDe(404), revisor: ERNESTO })).rejects.toThrow(CasoNoEncontrado);
    expect(await contar('decision_lead', "actor = 'ernesto'")).toBe(1);
  });

  // --- Corregir ------------------------------------------------------------------------------------------------------------

  it('Escenario «Corrección de Ernesto»: sin el dato que cambia su criterio no se guarda la corrección', async () => {
    const id = await caso(1);
    for (const dato of [undefined, '', '   ']) {
      await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: dato } })).rejects.toThrow('Falta el dato');
    }
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { motivo_codigo: 'no_interesado', dato_cita: 'x' } })).rejects.toThrow('La decisión debe ser');
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', dato_cita: 'x' } })).rejects.toThrow('El motivo debe ser');
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'falta_plano', dato_cita: 'x' } })).rejects.toThrow('El motivo debe ser');
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'otro', dato_cita: 'x' } })).rejects.toThrow('hay que escribir cuál');
    expect(await contar('decision_lead', "actor = 'ernesto'")).toBe(0);
    expect((await base.query('SELECT estado FROM validacion_decision')).rows[0]!.estado).toBe('pendiente_ernesto');
  });

  it('corrige con decisión, motivo y dato: queda «corregida» con su fila y, si no edita los pasos, los de la IA', async () => {
    const id = await caso(1);
    const fila = await corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'El cliente dijo que ya contrató a otra empresa' } });
    expect(fila).toMatchObject({ actor: 'ernesto', decision: 'descartar', motivoCodigo: 'no_interesado', datoCita: 'El cliente dijo que ya contrató a otra empresa', aFavor: null, proximosPasos: [PASO] });
    expect((await base.query('SELECT estado, revisado_por FROM validacion_decision')).rows[0]).toEqual({ estado: 'corregida', revisado_por: '77' });
  });

  it('Ernesto puede editar los próximos pasos al corregir; deben ser válidos (hasta 3)', async () => {
    const id = await caso(1);
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'seguimiento', motivo_codigo: 'falta_plano', dato_cita: 'x' }, proximosPasos: [{ accion: '' }] })).rejects.toThrow('El próximo paso 1 está incompleto');
    expect(await contar('decision_lead', "actor = 'ernesto'")).toBe(0);
    const fila = await corregirCaso(db, {
      llamadaId: id, revisor: ERNESTO, entrada: { decision: 'seguimiento', motivo_codigo: 'falta_plano', dato_cita: 'Nuevo dato' },
      proximosPasos: [{ accion: 'Escribir por WhatsApp', cuando: { tipo: 'plazo_guion', valor: 'mañana' }, canal: 'whatsapp', requiere_ernesto: false }],
    });
    expect(fila.proximosPasos).toEqual([{ orden: 1, accion: 'Escribir por WhatsApp', cuando: { tipo: 'plazo_guion', valor: 'mañana' }, canal: 'whatsapp', quePedir: null, requiereErnesto: false, cita: null }]);
    // Una lista vacía también es una edición: Ernesto quita los pasos.
    const id2 = await caso(2);
    const sinPasos = await corregirCaso(db, { llamadaId: id2, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'x' }, proximosPasos: [] });
    expect(sinPasos.proximosPasos).toEqual([]);
  });

  it('la lista de motivos de la corrección es la configurada: una versión nueva cambia lo que se acepta', async () => {
    const id = await caso(1);
    await base.query("INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (2, 'descartar', 'motivo_de_la_v2', 'De la v2', 1)");
    await expect(corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'x' } })).rejects.toThrow('El motivo debe ser');
    const f = await corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'motivo_de_la_v2', dato_cita: 'x' } });
    expect(f.motivoCodigo).toBe('motivo_de_la_v2');
  });

  // --- Acierto -------------------------------------------------------------------------------------------------------------

  it('Escenario «Medición del acierto»: 10 casos coincidentes revisados y 9 confirmados dan un 90 % con 10 casos; el histórico no suma', async () => {
    for (let n = 1; n <= 10; n++) {
      const id = await caso(n);
      if (n <= 9) await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO });
      else await corregirCaso(db, { llamadaId: id, revisor: ERNESTO, entrada: { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'cambió de idea' } });
    }
    // 50 llamadas de la calibración con el histórico: decisión de la IA como `historico`, sin caso ni revisión.
    for (let n = 100; n < 150; n++) await guardarIA(await llamadaDeLead(n), ia(), { origen: 'historico' });
    const filas = await acierto(db);
    expect(filas.find((f) => f.actor === 'coincidentes')).toEqual({ actor: 'coincidentes', revisados: 10, aciertos: 9, porcentaje: 90 });
    expect(filas.find((f) => f.actor === 'sdr')).toMatchObject({ revisados: 10, aciertos: 9 });
    expect(filas.find((f) => f.actor === 'ia')).toMatchObject({ revisados: 10, aciertos: 9 });
  });

  it('los casos pendientes no cuentan y sin casos no hay porcentaje', async () => {
    expect((await acierto(db)).every((f) => f.revisados === 0 && f.porcentaje === null)).toBe(true);
    await caso(1);
    expect((await acierto(db)).every((f) => f.revisados === 0)).toBe(true);
  });

  it('el acierto de cada actor mira decisión y motivo finales de Ernesto', async () => {
    const id = await caso(1, ia({ decision: 'derivar_partners', motivos: [{ codigo: 'presupuesto_partners', texto: null, cita: 'unos treinta mil euros' }] }), sdr({ decision: 'descartar', motivoCodigo: 'presupuesto_insuficiente' }));
    await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO, aFavor: 'ia' });
    const filas = await acierto(db);
    expect(filas.find((f) => f.actor === 'coincidentes')).toMatchObject({ revisados: 0, porcentaje: null });
    expect(filas.find((f) => f.actor === 'sdr')).toMatchObject({ revisados: 1, aciertos: 0, porcentaje: 0 });
    expect(filas.find((f) => f.actor === 'ia')).toMatchObject({ revisados: 1, aciertos: 1, porcentaje: 100 });
  });

  // --- Decisión final en la tarjeta -------------------------------------------------------------------------------------------

  it('la decisión final de un lead es la última que revisó Ernesto, con quién la tomó; sin revisión, ninguna', async () => {
    expect(await decisionFinalDelLead(db, 'T1')).toBeNull();
    const id = await caso(1);
    expect(await decisionFinalDelLead(db, 'T1')).toBeNull();
    await confirmarCaso(db, { llamadaId: id, revisor: ERNESTO });
    expect(await decisionFinalDelLead(db, 'T1')).toBe('Seguimiento · Ernesto');
    const id2 = await caso(2);
    await corregirCaso(db, { llamadaId: id2, revisor: { usuarioId: '8', usuarioNombre: 'Dirección' }, entrada: { decision: 'pasar_a_reunion', motivo_codigo: 'cumple_criterios', dato_cita: 'Ya tiene el plano y los decisores' } });
    expect(await decisionFinalDelLead(db, 'T1')).toBe('Pasar a reunión · Dirección');
    expect(await decisionFinalDelLead(db, 'OTRO')).toBeNull();
  });
});
