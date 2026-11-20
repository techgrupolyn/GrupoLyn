// N-1.4 · La decisión de pase de la IA dentro del proceso de una llamada: modelo programado → verificación → base → SDR → Ernesto.
// Cubre los escenarios de aceptación del ticket que dependen del modelo. Sin red.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { acierto, bandeja, confirmarCaso, llamadaIdDe, registrarPropuestaSDR, vistaParaSDR } from '../netelip/captacion/decision-repositorio.ts';
import { evaluarLlamadaCaptacion, interaccionDe, type Dependencias, type EntradaLlamada } from '../netelip/captacion/proceso.ts';
import { VERSION_PROMPT } from '../netelip/captacion/prompt.ts';
import type { Db } from '../netelip/captacion/repositorio.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import type { LeadCandidato } from '../netelip/captacion/vinculacion.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { CITA_FECHA, FRASE, salidaModelo, TRANSCRIPCION_CON_FECHA } from './helpers/captacion-llamadas.ts';

const LEADS: LeadCandidato[] = [{ clickupTaskId: 'lead-ana', esTareaPadre: true, telefono: '+34 600 111 222', email: null }];

const paso = (o: Record<string, unknown> = {}) => ({
  orden: 1, accion: 'Confirmar la visita del viernes', cuando: { tipo: 'fecha_cliente', valor: 'viernes 20 a las seis' }, canal: 'llamada', que_pedir: null, requiere_ernesto: false, cita: CITA_FECHA, ...o,
});
const DECISION = {
  decision: 'pasar_a_reunion', motivos: [{ codigo: 'presupuesto_suficiente', cita: FRASE.decisor, texto: null }], excepciones: [], dudas: [], pendiente_ernesto: null, proximos_pasos: [paso()],
};
const dec = (o: Record<string, unknown> = {}) => ({ ...DECISION, ...o });

const llamada = (extra: Partial<EntradaLlamada> = {}): EntradaLlamada => ({
  llamadaId: '77', telefonoE164: '+34600111222', ocurridaEn: new Date('2026-11-17T10:00:00Z'), direccion: 'outbound', duracionSegundos: 240,
  transcripcion: TRANSCRIPCION_CON_FECHA, ...extra,
});

describe.skipIf(!hayBaseDePruebas)('decisión de pase de la IA en el proceso de una llamada', () => {
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

  function montar(decisionIA: unknown, extra: Partial<Dependencias> = {}) {
    const peticiones: Array<{ system: string; user: string }> = [];
    const deps: Dependencias = {
      conDb: (fn) => fn(db), leads: LEADS, nombreLead: () => null,
      evaluar: async (system, user): Promise<RespuestaModelo> => {
        peticiones.push({ system, user });
        const id = /interaccion_id (\S+)/.exec(user)![1]!;
        return { text: salidaModelo(id, { decisionIA }), model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
      },
      ...extra,
    };
    return { deps, peticiones };
  }
  const procesar = async (decisionIA: unknown, extra: Partial<Dependencias> = {}, l: Partial<EntradaLlamada> = {}) => {
    const p = montar(decisionIA, extra);
    const r = await evaluarLlamadaCaptacion(p.deps, llamada(l));
    if (r.estado !== 'procesada') throw new Error(`no procesada: ${r.estado}`);
    return { r, ...p };
  };
  const filaIA = async () => (await base.query('SELECT * FROM decision_lead WHERE actor = $1', ['ia'])).rows[0];

  // --- Reintento cuando el modelo no da decisión ---------------------------------------------------------------------------------

  /** Un modelo que contesta cada vez con la decisión siguiente de la lista (la última se repite); `undefined` = sin decisión. */
  const guionado = (...respuestas: Array<unknown | { roto: true } | { falla: true }>) => {
    const cuenta = { n: 0 };
    const evaluar: Dependencias['evaluar'] = async (_system, user): Promise<RespuestaModelo> => {
      const r = respuestas[Math.min(cuenta.n, respuestas.length - 1)] as { roto?: true; falla?: true } | undefined;
      cuenta.n += 1;
      if (r?.falla) throw new Error('el modelo no contesta');
      const id = /interaccion_id (\S+)/.exec(user)![1]!;
      return { text: r?.roto ? 'esto no es JSON' : salidaModelo(id, { decisionIA: r }), model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
    };
    return { evaluar, cuenta };
  };
  const correr = async (m: ReturnType<typeof guionado>, extra: Partial<Dependencias> = {}) => {
    const r = await evaluarLlamadaCaptacion(montar(undefined, { evaluar: m.evaluar, ...extra }).deps, llamada());
    if (r.estado !== 'procesada') throw new Error(`no procesada: ${r.estado}`);
    return r;
  };

  it('si el modelo no da decisión para un lead que la exige, se le vuelve a pedir UNA vez y la segunda se guarda', async () => {
    const m = guionado(undefined, DECISION);
    const r = await correr(m, { reintentarDecision: true });
    expect(m.cuenta.n).toBe(2);
    expect(r.decision).toEqual({ estado: 'guardada', decision: 'pasar_a_reunion' });
    expect(r.decisionReintentada).toBe(true);
    expect(await contar('decision_lead', "actor = 'ia'")).toBe(1);
    // La calificación y el resumen no se duplican por la segunda respuesta.
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('sin la bandera, o con decisión a la primera, no hay segunda llamada al modelo', async () => {
    const apagado = guionado(undefined, DECISION);
    expect((await correr(apagado)).decision).toEqual({ estado: 'sin_decision' });
    expect(apagado.cuenta.n).toBe(1);
    const completo = guionado(DECISION, DECISION);
    const r = await correr(completo, { reintentarDecision: true });
    expect(completo.cuenta.n).toBe(1);
    expect(r.decisionReintentada).toBeUndefined();
  });

  it('se reintenta una sola vez: si la segunda tampoco trae decisión, la llamada queda sin decisión tras dos llamadas', async () => {
    const m = guionado(undefined);
    const r = await correr(m, { reintentarDecision: true });
    expect(m.cuenta.n).toBe(2);
    expect(r.decision).toEqual({ estado: 'sin_decision' });
    expect(r.decisionReintentada).toBe(true);
    expect(await contar('decision_lead')).toBe(0);
  });

  it('un lead en F2 o más allá no genera decisión y tampoco la pide otra vez', async () => {
    const m = guionado(undefined, DECISION);
    const r = await correr(m, { reintentarDecision: true, etapaLead: () => 4 });
    expect(m.cuenta.n).toBe(1);
    expect(r.decision).toEqual({ estado: 'omitida' });
  });

  it('si la segunda respuesta viene rota o el modelo falla, la llamada no se pierde: queda calificada y sin decisión', async () => {
    for (const segunda of [{ roto: true as const }, { falla: true as const }]) {
      await base.query('TRUNCATE decision_lead, lead_criterio_evaluacion, lead_presupuesto_evento, lead_calificacion_historial, lead_resumen_historial CASCADE');
      const m = guionado(undefined, segunda);
      const r = await correr(m, { reintentarDecision: true });
      expect(m.cuenta.n).toBe(2);
      expect(r.decision).toEqual({ estado: 'sin_decision' });
      expect(await contar('lead_criterio_evaluacion')).toBe(7);
    }
  });

  it('guarda la decisión de la IA con su motivo, sus pasos y las versiones del guion, del manual y del prompt con que decidió', async () => {
    const { r } = await procesar(DECISION);
    expect(r.decision).toEqual({ estado: 'guardada', decision: 'pasar_a_reunion' });
    expect(await filaIA()).toMatchObject({
      lead_id: 'lead-ana', llamada_id: interaccionDe('77'), decision: 'pasar_a_reunion', motivo_codigo: 'presupuesto_suficiente', dato_cita: FRASE.decisor,
      version_guion: 1, version_manual: 1, version_prompt: VERSION_PROMPT, origen: 'nuevo',
    });
    expect((await filaIA()).proximos_pasos).toEqual([{ orden: 1, accion: 'Confirmar la visita del viernes', cuando: { tipo: 'fecha_cliente', valor: 'viernes 20 a las seis' }, canal: 'llamada', quePedir: null, requiereErnesto: false, cita: CITA_FECHA }]);
    expect(r.descartes).toEqual([]);
    // La calificación de la llamada sigue guardándose como siempre.
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('Escenario «Versión del contexto»: con el guion en la versión 2 activa, la decisión guarda la versión 2 del guion y la vigente del manual', async () => {
    await base.query("INSERT INTO decision_contexto_config (tipo, version, texto) VALUES ('guion', 2, 'TEXTO DEL GUION DE LA VERSION DOS')");
    const { peticiones } = await procesar(DECISION);
    expect(await filaIA()).toMatchObject({ version_guion: 2, version_manual: 1 });
    expect(peticiones[0]!.system).toContain('### Guion del SDR (versión 2)');
    expect(peticiones[0]!.system).toContain('TEXTO DEL GUION DE LA VERSION DOS');
    expect(peticiones[0]!.system).toContain('### Manual de reglas (versión 1)');
  });

  it('con el manual en la versión 2 activa, la decisión guarda la versión 2 del manual', async () => {
    await base.query("INSERT INTO decision_contexto_config (tipo, version, texto) VALUES ('manual', 2, 'TEXTO DEL MANUAL DE LA VERSION DOS')");
    const { peticiones } = await procesar(DECISION);
    expect(await filaIA()).toMatchObject({ version_guion: 1, version_manual: 2 });
    expect(peticiones[0]!.system).toContain('### Manual de reglas (versión 2)');
  });

  it('la lista de motivos que ve el modelo es la de la base: una versión nueva cambia el prompt sin desplegar', async () => {
    await base.query("INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (2, 'seguimiento', 'motivo_de_la_v2', 'Un motivo de la versión dos', 1)");
    const { peticiones } = await procesar(DECISION);
    expect(peticiones[0]!.system).toContain('seguimiento: motivo_de_la_v2 (Un motivo de la versión dos)');
    expect(peticiones[0]!.system).not.toContain('falta_dato_cliente (Falta un dato del cliente)');
  });

  it('Escenario «Independencia de la IA»: con la propuesta del SDR ya registrada, la petición al modelo no la incluye', async () => {
    await base.query(
      `INSERT INTO lead_criterio_evaluacion (clickup_task_id, criterio_id, nivel, origen, interaccion_id, fecha_interaccion) VALUES ('lead-ana', 'presupuesto', 'NE', 'llamada', $1, now())`,
      [interaccionDe('77')],
    );
    await registrarPropuestaSDR(db, {
      llamadaId: interaccionDe('77'), usuarioId: '5', usuarioNombre: 'Sara SDR',
      entrada: { decision: 'descartar', motivoCodigo: 'otro', motivoTexto: 'MOTIVO-SECRETO-DEL-SDR', datoCita: 'DATO-SECRETO-DEL-SDR' },
    });
    const { peticiones } = await procesar(DECISION);
    const todo = `${peticiones[0]!.system}\n${peticiones[0]!.user}`;
    for (const secreto of ['MOTIVO-SECRETO-DEL-SDR', 'DATO-SECRETO-DEL-SDR', 'Sara SDR']) expect(todo).not.toContain(secreto);
    expect(await filaIA()).toMatchObject({ decision: 'pasar_a_reunion' });
  });

  it('Escenario «Solo decisiones de pase del SDR»: un lead en F2 (e4) o más allá no genera decisión y el modelo no la pide', async () => {
    const { r, peticiones } = await procesar(DECISION, { etapaLead: () => 4 });
    expect(r.decision).toEqual({ estado: 'omitida' });
    expect(await contar('decision_lead')).toBe(0);
    expect(peticiones[0]!.user).toContain('Decisión de pase: no aplica, el lead ya está en F2 o más allá. Devuelve decision_ia null.');
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('antes de F2 (e1 a e3) y sin etapa conocida sí se genera la decisión, y el modelo no oye hablar de F2', async () => {
    for (const [n, etapa] of [[1, 1], [2, 3], [3, null]] as const) {
      const { r, peticiones } = await procesar(DECISION, { etapaLead: () => etapa }, { llamadaId: String(n) });
      expect(r.decision, `etapa ${etapa}`).toMatchObject({ estado: 'guardada' });
      expect(peticiones[0]!.user).not.toContain('no aplica');
    }
    expect(await contar('decision_lead', "actor = 'ia'")).toBe(3);
  });

  it('un lead de F2 también se califica y se resume como siempre (solo se omite la decisión)', async () => {
    const { r } = await procesar(DECISION, { etapaLead: () => 9 });
    expect(r.categoria).toBeDefined();
    expect(r.resumen.estado).toBe('vacio');
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('si el modelo no devuelve decisión (null o ausente) la llamada se califica igual y no se guarda nada', async () => {
    for (const [n, valor] of [[1, null], [2, undefined], [3, 'nada'], [4, 5]] as const) {
      const { r } = await procesar(valor, {}, { llamadaId: String(n) });
      expect(r.decision, String(valor)).toEqual({ estado: 'sin_decision' });
      expect(r.descartes).toEqual([]);
    }
    expect(await contar('decision_lead')).toBe(0);
    expect(await contar('lead_criterio_evaluacion')).toBe(28);
  });

  it('una decisión que no es de las cuatro no se guarda, consta como descarte y la calificación sí se registra', async () => {
    const { r } = await procesar(dec({ decision: 'esperar' }));
    expect(r.decision).toEqual({ estado: 'invalida', motivo: 'la decisión de la IA no es una de las cuatro posibles' });
    expect(r.descartes).toEqual([{ campo: 'decision_ia', motivo: 'la decisión de la IA no es una de las cuatro posibles', cita: null }]);
    expect(await contar('decision_lead')).toBe(0);
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('un motivo con una cita que no está en la llamada se descarta; sin ninguno citable la decisión queda «Pendiente de Ernesto»', async () => {
    const { r } = await procesar(dec({ motivos: [{ codigo: 'presupuesto_suficiente', cita: 'Dijo que sí a todo desde el primer minuto', texto: null }] }));
    expect(r.descartes).toEqual([{ campo: 'decision_ia.motivos.presupuesto_suficiente', motivo: 'cita no encontrada en la transcripción', cita: null }]);
    expect(await filaIA()).toMatchObject({ motivo_codigo: null, dato_cita: null, pendiente_ernesto: { queDebeDecidir: 'La IA no pudo citar la llamada para justificar su decisión.' } });
  });

  it('un código de motivo que no está en la lista pasa a «otro» con su texto', async () => {
    await procesar(dec({ motivos: [{ codigo: 'se_va_de_vacaciones', cita: FRASE.decisor, texto: 'Se va de vacaciones un mes' }] }));
    expect(await filaIA()).toMatchObject({ motivo_codigo: 'otro', motivo_texto: 'Se va de vacaciones un mes' });
  });

  it('un próximo paso sin cita verificable se descarta y consta: cita obligatoria y verificada en cada paso', async () => {
    const { r } = await procesar(dec({ proximos_pasos: [paso(), paso({ orden: 2, accion: 'Inventado', cita: 'una frase que el cliente nunca dijo' })] }));
    expect((await filaIA()).proximos_pasos).toHaveLength(1);
    expect(r.descartes).toEqual([{ campo: 'decision_ia.proximos_pasos', motivo: 'cita no encontrada en la transcripción', cita: null }]);
  });

  it('las citas de la decisión se comprueban contra la transcripción ENMASCARADA, la que vio el modelo (datos personales fuera)', async () => {
    const cita = 'Me llamo [NOMBRE] y lo decidimos juntos mi marido y yo';
    const texto = `${TRANSCRIPCION_CON_FECHA}\n[00:03:00] CLIENTE: Me llamo Ana Beltrán y lo decidimos juntos mi marido y yo.`;
    const { peticiones, r } = await procesar(dec({ motivos: [{ codigo: 'presupuesto_suficiente', cita, texto: null }] }), { nombreLead: () => 'Ana Beltrán' }, { transcripcion: texto });
    expect(peticiones[0]!.user).toContain('Me llamo [NOMBRE] y lo decidimos');
    expect(peticiones[0]!.user).not.toContain('Beltrán');
    expect(r.descartes).toEqual([]);
    expect(await filaIA()).toMatchObject({ dato_cita: cita });
  });

  it('Escenario «Próximo paso que necesita una excepción»: queda marcado «requiere Ernesto» y el caso espera por «excepcion»', async () => {
    await procesar(dec({ excepciones: ['topografo'], proximos_pasos: [paso({ accion: 'Valorar enviar a alguien a medir', requiere_ernesto: true })] }));
    const id = interaccionDe('77');
    await registrarPropuestaSDR(db, { llamadaId: id, usuarioId: '5', usuarioNombre: 'Sara SDR', entrada: { decision: 'pasar_a_reunion', motivoCodigo: 'presupuesto_suficiente', motivoTexto: null, datoCita: 'Dijo que sí' } });
    expect((await filaIA()).proximos_pasos[0]).toMatchObject({ requiereErnesto: true });
    expect((await base.query('SELECT motivo_escalado, coincidencia_sdr_ia FROM validacion_decision')).rows[0]).toEqual({ motivo_escalado: 'excepcion', coincidencia_sdr_ia: true });
  });

  it('sin la configuración de la decisión (tablas sin sembrar) la llamada se califica igual, el prompt usa el contexto provisional y no se guarda decisión', async () => {
    await base.query('DELETE FROM decision_contexto_config');
    const { r, peticiones } = await procesar(DECISION);
    expect(r.decision).toEqual({ estado: 'omitida' });
    expect(peticiones[0]!.system).toContain('MANUAL DE REGLAS v1 (provisional)');
    expect(await contar('decision_lead')).toBe(0);
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
  });

  it('carrera SDR/IA: la decisión de la IA se guarda bajo el mismo bloqueo por lead que la propuesta del SDR, antes de leer o escribir nada', async () => {
    const sqls: string[] = [];
    const espia = { query: (sql: string, params?: unknown[]) => { sqls.push(sql); return db.query(sql, params); } } as unknown as Db;
    await procesar(DECISION, { conDb: (fn) => fn(espia) });
    const comienzo = sqls.findIndex((s) => s.trim() === 'BEGIN');
    expect(comienzo).toBeGreaterThanOrEqual(0);
    // Lo primero que hace la transacción es bloquear el lead (mismo espacio y clave que registrarPropuestaSDR): dos procesos del mismo lead se serializan.
    expect(sqls[comienzo + 1]).toContain('pg_advisory_xact_lock');
  });

  it('reprocesar la misma llamada no duplica la decisión ni cambia la primera', async () => {
    await procesar(DECISION);
    const { r } = await procesar(dec({ decision: 'descartar' }));
    expect(r.decision).toEqual({ estado: 'ya_existia', decision: 'descartar' });
    expect(await contar('decision_lead', "actor = 'ia'")).toBe(1);
    expect(await filaIA()).toMatchObject({ decision: 'pasar_a_reunion' });
  });

  it('en la calibración con el histórico, la decisión de la IA queda como «historico» y no crea caso aunque haya propuesta del SDR', async () => {
    const { r } = await procesar(DECISION, { origenDecision: 'historico' });
    expect(r.decision).toMatchObject({ estado: 'guardada' });
    expect(await filaIA()).toMatchObject({ origen: 'historico' });
    await registrarPropuestaSDR(db, { llamadaId: interaccionDe('77'), usuarioId: '5', usuarioNombre: 'Sara', entrada: { decision: 'pasar_a_reunion', motivoCodigo: 'presupuesto_suficiente', motivoTexto: null, datoCita: 'x' } });
    expect(await contar('validacion_decision')).toBe(0);
  });

  it('recorrido completo: la IA decide, el SDR registra, ve a la IA, Ernesto confirma y el acierto lo cuenta', async () => {
    await procesar(DECISION);
    const id = llamadaIdDe(77);
    const antes = await vistaParaSDR(db, interaccionDe('77'));
    expect(antes).toMatchObject({ leadConocido: true, sdr: null, ia: null });
    await registrarPropuestaSDR(db, { llamadaId: interaccionDe('77'), usuarioId: '5', usuarioNombre: 'Sara SDR', entrada: { decision: 'pasar_a_reunion', motivoCodigo: 'presupuesto_suficiente', motivoTexto: null, datoCita: 'Dijo que viene con su pareja' } });
    const despues = await vistaParaSDR(db, interaccionDe('77'));
    expect(despues.ia).toMatchObject({ decision: 'pasar_a_reunion', proximosPasos: [expect.objectContaining({ accion: 'Confirmar la visita del viernes' })] });
    const casos = await bandeja(db);
    expect(casos).toHaveLength(1);
    expect(casos[0]).toMatchObject({ llamadaId: id, motivoEscalado: 'piloto', coincide: true, estado: 'pendiente_ernesto' });
    await confirmarCaso(db, { llamadaId: id, revisor: { usuarioId: '77', usuarioNombre: 'Ernesto' } });
    expect((await acierto(db)).find((f) => f.actor === 'coincidentes')).toEqual({ actor: 'coincidentes', revisados: 1, aciertos: 1, porcentaje: 100 });
  });
});
