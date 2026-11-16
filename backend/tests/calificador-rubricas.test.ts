// Rúbricas versionadas del calificador (ticket 869fpj8dm): versión, nota por pasos, consentimiento,
// reevaluación bajo demanda y calibración. Sin base de datos real ni Gemini.
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { decidir, detectarNegativaGrabacion, notaPorPasos, SalidaInvalida, validarSalida } from '../netelip/calificador/reglas.ts';
import { esquemaSalida, promptVersionado, RUBRICA_SDR_V1, RubricaInvalida, validarDefinicion, type DefinicionRubrica } from '../netelip/calificador/rubrica.ts';
import { promptSistemaVersionado } from '../netelip/calificador/modelo.ts';
import { enviarPendientes, procesarSiguienteEvaluacion, type ConfigCalificador } from '../netelip/calificador/proceso.ts';
import { crearReevaluaciones } from '../netelip/calificador/reevaluar.ts';
import { comparar, informeCalibracion, leerCalibracion } from '../netelip/calificador/calibracion.ts';

const V1 = RUBRICA_SDR_V1;
const pasos = (puntos: number[], noAplican: number[] = []) => V1.criterios.map((c, i) => ({ paso: c.paso, aplica: !noAplican.includes(c.paso), puntos: noAplican.includes(c.paso) ? 0 : puntos[i], comentario: 'evidencia' }));
const salida = (over: Record<string, unknown> = {}) => JSON.stringify({
  llamada_evaluable: true, motivo_no_evaluable: null, pasos: pasos([5, 20, 12, 16, 8, 8, 12]), errores_criticos: [],
  bien: ['Retoma su prioridad al proponer', 'Ofrece dos fechas concretas'],
  mejorar: [{ que: 'Resume antes de la horquilla', accion: 'Repite alcance y prioridad y espera su sí' }, { que: 'Pide plano o fotos', accion: 'Pide que envíe plano o vídeo antes de la sesión' }],
  duda: { valor: false, motivo: null }, objeciones: [], ...over,
});

describe('Rúbrica SDR v1 (guion completo, 7 pasos)', () => {
  it('se carga con los 7 pasos y pesos del ticket, que suman 100, y los 3 errores críticos', () => {
    expect(V1.codigo).toBe('sdr-v1');
    expect(V1.criterios.map((c) => [c.nombre, c.peso])).toEqual([
      ['Apertura', 5], ['Escuchar y comprender', 25], ['Resumir y confirmar', 15], ['Cómo ayuda LYN', 20],
      ['Horquilla', 10], ['Confirmar avance', 10], ['Asistentes, documentación y agenda', 15]]);
    expect(V1.errores_criticos.map((e) => e.codigo)).toEqual(['REGLA_CERO', 'LIMITE_PROFESIONAL', 'EXCEPCION_SIN_AUTORIZACION']);
    expect(V1.nota_apto).toBe(80);
  });

  it('una definición inválida no se publica: pesos que no suman 100, código mal formado, errores repetidos', () => {
    const mal = (cambio: Partial<DefinicionRubrica>) => () => validarDefinicion({ ...V1, ...cambio });
    expect(mal({ criterios: V1.criterios.map((c, i) => ({ ...c, peso: i === 0 ? 10 : c.peso })) })).toThrow(/suman 105/);
    expect(mal({ codigo: 'SDR v2' })).toThrow(RubricaInvalida);
    expect(mal({ errores_criticos: [V1.errores_criticos[0], V1.errores_criticos[0]] })).toThrow(/repetidos/);
    expect(mal({ rol: 'jefe' as never })).toThrow(/rol/);   // closer_f4 ya es válido (869fppbcj)
  });

  it('el prompt y el esquema salen de la versión: una v2 cambia el prompt sin tocar código', () => {
    const p1 = promptVersionado(V1);
    for (const c of V1.criterios) expect(p1).toContain(`Paso ${c.paso} · ${c.nombre} (${c.peso} puntos)`);
    expect(p1).toContain('EXCEPCION_SIN_AUTORIZACION');
    expect(p1).toContain('«Idea 2»');
    expect(p1).toContain('rúbrica sdr-v1');
    const v2 = validarDefinicion({ ...V1, codigo: 'sdr-v2', version: 2, criterios: [...V1.criterios.slice(0, 6), { ...V1.criterios[6], nombre: 'Agenda y decisores', descripcion: 'Nueva descripción del paso 7' }] });
    const p2 = promptSistemaVersionado(v2);
    expect(p2).toContain('Paso 7 · Agenda y decisores (15 puntos)');
    expect(p2).toContain('rúbrica sdr-v2');
    expect(p2).not.toContain('Asistentes, documentación y agenda');
    const esquema = esquemaSalida(V1) as { properties: { errores_criticos: { items: { properties: { regla: { enum: string[] } } } } } };
    expect(esquema.properties.errores_criticos.items.properties.regla.enum).toEqual(['REGLA_CERO', 'LIMITE_PROFESIONAL', 'EXCEPCION_SIN_AUTORIZACION']);
  });
});

describe('Nota con los 7 pasos y sus pesos', () => {
  it('la nota la calcula el código con los pasos, no el modelo', () => {
    const s = validarSalida(salida({ nota: 99 }), V1);
    expect(s.nota).toBe(81); // 5+20+12+16+8+8+12 = 81 de 100
    expect(s.pasos).toHaveLength(7);
    expect(s.pasos![1]).toMatchObject({ nombre: 'Escuchar y comprender', peso: 25, puntos: 20, aplica: true });
  });

  it('un paso que no aplica (rellamada sin horquilla) no resta: se reparte sobre los que aplican', () => {
    expect(notaPorPasos([{ peso: 50, aplica: true, puntos: 40 }, { peso: 50, aplica: false, puntos: 0 }])).toBe(80);
    const s = validarSalida(salida({ pasos: pasos([5, 25, 15, 20, 0, 10, 15], [5]) }), V1);
    expect(s.nota).toBe(100);
  });

  it('rechaza puntos por encima del peso, pasos que faltan y errores que no son de la versión', () => {
    expect(() => validarSalida(salida({ pasos: pasos([6, 20, 12, 16, 8, 8, 12]) }), V1)).toThrow(/pasos\[1\]\.puntos fuera de 0-5/);
    expect(() => validarSalida(salida({ pasos: pasos([5, 20, 12, 16, 8, 8, 12]).slice(0, 6) }), V1)).toThrow(/falta el paso 7/);
    expect(() => validarSalida(salida({ errores_criticos: [{ regla: 'NO_PREGUNTAR', cita: 'x', marca_tiempo: '' }] }), V1)).toThrow(SalidaInvalida);
  });

  it('topógrafo prometido sin autorización: EXCEPCIÓN SIN AUTORIZACIÓN escala con su nombre legible', () => {
    const transcripcion = '[00:04:10] GRUPO LYN: No te preocupes, el topógrafo os va a ir a medir el martes sin problema.';
    const s = validarSalida(salida({ errores_criticos: [{ regla: 'EXCEPCION_SIN_AUTORIZACION', cita: 'el topógrafo os va a ir a medir el martes', marca_tiempo: '00:04:10' }] }), V1);
    const d = decidir(s, transcripcion, { presupuestoRegistrado: false, supervisor: 'Ernesto', notaApto: V1.nota_apto, nombresReglas: Object.fromEntries(V1.errores_criticos.map((e) => [e.codigo, e.nombre])) });
    expect(d.errores_criticos).toHaveLength(1);
    expect(d.apto).toBe(false);
    expect(d.motivo_escalado).toContain('EXCEPCIÓN SIN AUTORIZACIÓN');
  });
});

describe('Consentimiento de grabación', () => {
  it('detecta la negativa del cliente y la respuesta del guion', () => {
    expect(detectarNegativaGrabacion('[00:00:20] CLIENTE: Prefiero que no se grabe, la verdad.')).toBe('Prefiero que no se grabe, la verdad.');
    expect(detectarNegativaGrabacion('[00:00:15] CLIENTE: No, no quiero que me grabes.')).toBeTruthy();
    expect(detectarNegativaGrabacion('[00:00:15] CLIENTE: no doy permiso para que se grabe')).toBeTruthy();
    expect(detectarNegativaGrabacion('[00:00:10] GRUPO LYN: ¿Te importa que grabemos la llamada?\n[00:00:12] CLIENTE: Pues sí, la verdad.\n[00:00:14] GRUPO LYN: Sin problema, tomo las notas yo.')).toBe('Sin problema, tomo las notas yo.');
  });

  it('no confunde un sí ni las hipótesis del comercial', () => {
    expect(detectarNegativaGrabacion('[00:00:10] GRUPO LYN: ¿Te importa que grabemos?\n[00:00:12] CLIENTE: No, no me importa que se grabe.')).toBeNull();
    expect(detectarNegativaGrabacion('[00:00:10] GRUPO LYN: Si no quiere que se grabe, tomo yo las notas, ¿vale?\n[00:00:12] CLIENTE: No, no, grabadla.')).toBeNull();
    expect(detectarNegativaGrabacion('[00:00:10] GRUPO LYN: Si lo prefieres, tomo yo las notas.')).toBeNull();
    expect(detectarNegativaGrabacion('[00:01:00] CLIENTE: Queremos grabar un vídeo de la cocina para enseñároslo.')).toBeNull();
  });
});

// --- Proceso con una base de datos simulada ---------------------------------------------------

type Query = { sql: string; params: unknown[] };
const FILA_V1 = { id: '3', codigo: V1.codigo, rol: V1.rol, version: 1, fuente: V1.fuente, nota_apto: 80, objetivo: V1.objetivo, criterios: V1.criterios, errores_criticos: V1.errores_criticos, reglas: V1.reglas, activo: true };
function fakePool(job: Record<string, unknown> | null) {
  const queries: Query[] = [];
  const responder = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/SET estado = 'procesando'/.test(sql)) return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    if (/FROM rubrica_version WHERE (id|codigo) = \$1/.test(sql)) return { rows: [FILA_V1], rowCount: 1 };
    if (/COUNT\(DISTINCT e\.llamada_id\)/.test(sql)) return { rows: [{ candidatas: 20, con_version: 0, sin_consentimiento: 1 }], rowCount: 1 };
    if (/INSERT INTO llamada_evaluacion/.test(sql)) return { rows: [], rowCount: 19 };
    return { rows: [], rowCount: 1 };
  };
  const pool = { query: responder, connect: async () => ({ query: responder, release: () => undefined }) };
  return { pool: pool as unknown as Pool, queries };
}
const CONFIG: ConfigCalificador = { supervisorNombre: 'Ernesto', supervisorWhatsapp: '+34600000000', dashboardUrl: null, envioActivo: true };
const JOB = { id: '7', llamada_id: '42', intentos: 1, rol: 'sdr', extension_netelip: '120', rubrica_version_id: '3', reevaluacion: false, sin_consentimiento_previo: false,
  direction: 'outbound', duration_seconds: 240, occurred_at: new Date('2026-11-09T09:32:00Z'), t_status: 'completed', t_text: '', lead_name: 'Lucía Fernández', client_name: '',
  segments: [{ speaker: 'agente', start: 3, end: 8, text: 'Hola Lucía, soy Marta de Grupo LYN, te llamo por la reforma que nos pediste.' }, { speaker: 'cliente', start: 20, end: 24, text: 'Sí, dime.' }] };

describe('Evaluación con la rúbrica vigente', () => {
  it('usa la versión de la fila: prompt y esquema de sdr-v1, nota por pasos y versión guardada', async () => {
    const { pool, queries } = fakePool({ ...JOB });
    let sistema = ''; let esquema: unknown;
    const evaluar = async (s: string, _u: string, sch?: object) => { sistema = s; esquema = sch; return { text: salida(), model: 'm', inputTokens: 1, outputTokens: 1 }; };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('evaluada');
    expect(sistema).toContain('rúbrica sdr-v1');
    expect(JSON.stringify(esquema)).toContain('EXCEPCION_SIN_AUTORIZACION');
    const update = queries.find((q) => /SET estado = 'evaluada'/.test(q.sql))!;
    expect(update.params[1]).toBe(81);
    expect(update.params[12]).toBe('sdr-v1');
    expect(JSON.parse(String(update.params[16]))).toHaveLength(7);
  });

  it('CAL-06: una fila pendiente de un closer sin rúbrica propia no va al modelo ni usa fase0-v1', async () => {
    const { pool, queries } = fakePool({ ...JOB, rubrica_version_id: null, rol: 'closer_f2', extension_netelip: '115' });
    const evaluar = async () => { throw new Error('no debería llamar al modelo'); };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('no_evaluada');
    const update = queries.find((q) => /SET estado = 'no_evaluada'/.test(q.sql))!;
    expect(update.params[1]).toBe('sin rúbrica para el rol closer_f2');
    expect(queries.some((q) => /SET estado = 'evaluada'/.test(q.sql))).toBe(false);
  });

  it('CAL-06: un closer con rúbrica activa se evalúa con ella', async () => {
    const { pool, queries } = fakePool({ ...JOB, rol: 'closer_f2', extension_netelip: '115', rubrica_version_id: '3' });
    let sistema = '';
    const evaluar = async (s: string) => { sistema = s; return { text: salida(), model: 'm', inputTokens: 1, outputTokens: 1 }; };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('evaluada');
    expect(sistema).toContain('rúbrica sdr-v1'); // FILA_V1 hace de rúbrica del closer en el simulado
    expect(queries.find((q) => /SET estado = 'evaluada'/.test(q.sql))!.params[12]).toBe('sdr-v1');
  });

  it('CAL-05: sdr-v1 no tiene el error crítico de precio cerrado tras la primera reunión (era de fase0-v1)', () => {
    expect(V1.errores_criticos.map((e) => e.codigo)).not.toContain('PRECIO_CERRADO_PRIMERA_REUNION');
  });

  it('sin versión en la fila, el SDR sigue con fase0-v1', async () => {
    const { pool, queries } = fakePool({ ...JOB, rubrica_version_id: null, rol: 'sdr' });
    const evaluar = async (_s: string, _u: string, sch?: object) => {
      expect(sch).toBeUndefined();
      return { text: JSON.stringify({ llamada_evaluable: true, motivo_no_evaluable: null, nota: 84, errores_criticos: [], bien: ['a uno', 'b dos'], mejorar: [{ que: 'x', accion: 'y' }, { que: 'z', accion: 'w' }], duda: { valor: false, motivo: null }, objeciones: [] }), model: 'm', inputTokens: 1, outputTokens: 1 };
    };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('evaluada');
    const update = queries.find((q) => /SET estado = 'evaluada'/.test(q.sql))!;
    expect(update.params[12]).toBe('fase0-v1');
    expect(update.params[16]).toBeNull();
  });

  it('cliente que no autoriza la grabación: no va al modelo y queda «sin consentimiento» sin objeciones', async () => {
    const segments = [...JOB.segments, { speaker: 'cliente', start: 30, end: 33, text: 'Prefiero que no se grabe la llamada.' }];
    const { pool, queries } = fakePool({ ...JOB, segments });
    const evaluar = async () => { throw new Error('no debería llamar al modelo'); };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('sin_consentimiento');
    expect(queries.some((q) => /sin_consentimiento = TRUE/.test(q.sql))).toBe(true);
    expect(queries.some((q) => /DELETE FROM objecion_marketing WHERE evaluacion_id/.test(q.sql))).toBe(true);
  });

  it('llamada «sin consentimiento» en una reevaluación: no se envía al modelo', async () => {
    const { pool } = fakePool({ ...JOB, reevaluacion: true, sin_consentimiento_previo: true });
    const evaluar = async () => { throw new Error('no debería llamar al modelo'); };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('sin_consentimiento');
  });

  it('las reevaluaciones no se envían al comercial', async () => {
    const { pool, queries } = fakePool(null);
    await enviarPendientes(pool, async () => undefined, CONFIG);
    expect(queries[0].sql).toMatch(/NOT e\.reevaluacion/);
  });
});

describe('Reevaluación bajo demanda', () => {
  it('crea filas nuevas con la versión pedida, sin tocar las anteriores y sin las «sin consentimiento»', async () => {
    const { pool, queries } = fakePool(null);
    const r = await crearReevaluaciones(pool, { codigo: 'sdr-v1', desde: '2026-11-01', hasta: '2026-11-15' });
    expect(r).toEqual({ codigo: 'sdr-v1', rol: 'sdr', candidatas: 20, creadas: 19, ya_evaluadas_con_esa_version: 0, sin_consentimiento: 1 });
    const insert = queries.find((q) => /INSERT INTO llamada_evaluacion/.test(q.sql))!;
    expect(insert.sql).toMatch(/rubrica_version_id, reevaluacion\)/);
    expect(insert.sql).toMatch(/\$4, TRUE/);
    expect(insert.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM llamada_evaluacion s WHERE s\.llamada_id = e\.llamada_id AND s\.sin_consentimiento\)/);
    expect(insert.sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(queries.some((q) => /^\s*UPDATE llamada_evaluacion/.test(q.sql))).toBe(false);
  });

  it('simular no crea nada; fechas mal escritas se rechazan', async () => {
    const { pool, queries } = fakePool(null);
    expect((await crearReevaluaciones(pool, { codigo: 'sdr-v1', desde: '2026-11-01', hasta: '2026-11-15', simular: true })).creadas).toBe(0);
    expect(queries.some((q) => /INSERT/.test(q.sql))).toBe(false);
    await expect(crearReevaluaciones(pool, { codigo: 'sdr-v1', desde: '15/11', hasta: '2026-11-15' })).rejects.toThrow(RubricaInvalida);
  });
});

describe('Calibración con Alex y Ernesto', () => {
  const ia = Array.from({ length: 10 }, (_, i) => ({ evaluacion_id: String(i + 1), llamada_id: String(100 + i), version_rubrica: 'sdr-v1', nota: 80, errores: i === 0 ? ['REGLA_CERO'] : [] }));
  it('acuerdo = mismos errores críticos y nota a 10 puntos o menos; se supera con 8 de 10', () => {
    const csv = ['evaluacion_id;llamada_id;fecha;duracion_min;extension;evaluador;nota_humana;errores_humanos',
      ...ia.map((f, i) => `${f.evaluacion_id};${f.llamada_id};;;120;Alex;${i < 2 ? 60 : 85};${i === 0 ? 'regla_cero' : ''}`), '11;;;;;;;'].join('\n');
    const humanas = leerCalibracion(csv);
    expect(humanas).toHaveLength(10); // la fila sin nota no cuenta
    const r = comparar(humanas, ia);
    expect(r.acuerdos).toBe(8);
    expect(r.superada).toBe(true);
    expect(r.filas[0]).toMatchObject({ errores_coinciden: true, diferencia: 20, acuerdo: false });
    expect(informeCalibracion(r, '2026-11-12')).toContain('**Resultado: SUPERADA** · acuerdo en 8 de 10');
  });

  it('con 7 de 10 no se supera', () => {
    const humanas = ia.map((f, i) => ({ evaluacion_id: f.evaluacion_id, evaluador: 'Ernesto', nota_humana: i < 3 ? 50 : 80, errores_humanos: f.errores }));
    expect(comparar(humanas, ia)).toMatchObject({ acuerdos: 7, superada: false });
  });
});
