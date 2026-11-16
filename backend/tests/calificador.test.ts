// Calificador interno de llamadas (ticket 869e9y98n): escenarios de aceptación sin base de datos ni Gemini.
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  citaVerificable, decidir, enmascarar, FEEDBACK_MAX_CARACTERES, FEEDBACK_MAX_LINEAS, marcaTiempo, SalidaInvalida, textoFeedback,
  transcripcionPorTurnos, validarSalida, type SalidaModelo,
} from '../netelip/calificador/reglas.ts';
import { evaluadorGemini, promptSistema, promptUsuario } from '../netelip/calificador/modelo.ts';
import { encolarEvaluacion, encolarPendientes, motivoSinRubrica } from '../netelip/calificador/encolar.ts';
import { MAX_INTENTOS, procesarSiguienteEvaluacion, textoSupervisor, type ConfigCalificador } from '../netelip/calificador/proceso.ts';

const TRANSCRIPCION = [
  '[00:00:03] GRUPO LYN: Hola, soy Marta de Grupo LYN, te llamo por la reforma que nos pediste. ¿Te pillo bien?',
  '[00:00:40] CLIENTE: Es un piso de 90 metros en Alicante y queremos tirar el muro de la cocina.',
  '[00:01:10] GRUPO LYN: Sí, ese muro se puede tirar sin problema, no te preocupes.',
  '[00:02:05] GRUPO LYN: ¿Y qué presupuesto tenéis más o menos para la obra?',
  '[00:03:30] CLIENTE: Me da miedo que la obra se alargue meses.',
  '[00:03:55] GRUPO LYN: Vale, pues lo hablas con tu marido y ya me dices algo.',
].join('\n');

const base = (over: Partial<SalidaModelo> = {}): SalidaModelo => ({
  llamada_evaluable: true, motivo_no_evaluable: null, nota: 88, errores_criticos: [],
  bien: ['Apertura clara partiendo de su solicitud', 'Confirmas que es buen momento'],
  mejorar: [{ que: 'Resume antes de proponer', accion: 'Repite tipo, metros y alcance y pide confirmación' }, { que: 'Explica qué obtiene en oficina', accion: 'Cuenta las tres cosas de la reunión antes de dar fecha' }],
  duda: { valor: false, motivo: null }, objeciones: [], ...over,
});
const ctx = { presupuestoRegistrado: false, supervisor: 'Ernesto' };
const feedbackDe = (s: SalidaModelo, d = decidir(s, TRANSCRIPCION, ctx)) => textoFeedback({ cuando: '05/11 10:32', duracionSegundos: 240, nota: s.nota, apto: d.apto, bien: s.bien, mejorar: s.mejorar, escalado: d.escalado, motivoEscalado: d.motivo_escalado, supervisor: 'Ernesto' });

describe('Calificador · feedback corto', () => {
  it('nota, 2 bien y 2 a mejorar con acción, en ≤ 5 líneas y ≤ 600 caracteres', () => {
    const texto = feedbackDe(base());
    const lineas = texto.split('\n');
    expect(lineas.length).toBeLessThanOrEqual(FEEDBACK_MAX_LINEAS);
    expect(texto.length).toBeLessThanOrEqual(FEEDBACK_MAX_CARACTERES);
    expect(lineas[0]).toBe('Llamada 05/11 10:32 (4 min): 88/100 · APTO');
    expect(lineas[1]).toContain('Apertura clara');
    expect(lineas.filter((l) => l.startsWith('➡️')).length).toBe(2);
    expect(texto).not.toContain('Escalado');
  });

  it('recorta textos largos sin pasar de 5 líneas ni 600 caracteres, también con escalado', () => {
    const largo = 'muy '.repeat(80);
    const s = base({ nota: 40, bien: [largo, largo], mejorar: [{ que: largo, accion: largo }, { que: largo, accion: largo }], duda: { valor: true, motivo: largo } });
    const texto = feedbackDe(s);
    expect(texto.split('\n').length).toBe(5);
    expect(texto.length).toBeLessThanOrEqual(FEEDBACK_MAX_CARACTERES);
    expect(texto.split('\n')[4]).toMatch(/^⚠️ Escalado a Ernesto: /);
  });
});

describe('Calificador · escalado (P-01)', () => {
  it('REGLA CERO con cita y minuto: error crítico, no apto y escalado a Ernesto', () => {
    const s = base({ nota: 85, errores_criticos: [{ regla: 'REGLA_CERO', cita: 'pues lo hablas con tu marido y ya me dices algo', marca_tiempo: '00:03:55' }] });
    const d = decidir(s, TRANSCRIPCION, ctx);
    expect(d.errores_criticos).toEqual([{ regla: 'REGLA_CERO', cita: 'pues lo hablas con tu marido y ya me dices algo', marca_tiempo: '00:03:55' }]);
    expect(d.apto).toBe(false);
    expect(d.escalado).toBe(true);
    expect(d.motivo_escalado).toBe('error crítico: REGLA CERO');
    expect(feedbackDe(s, d)).toContain('⚠️ Escalado a Ernesto: error crítico: REGLA CERO');
  });

  it('nota 72 sin errores críticos: escalado con el motivo «nota inferior a 80»', () => {
    const d = decidir(base({ nota: 72 }), TRANSCRIPCION, ctx);
    expect(d.escalado).toBe(true);
    expect(d.motivo_escalado).toBe('nota inferior a 80');
  });

  it('duda sobre viabilidad técnica: escala con el motivo y no marca error sin cita', () => {
    const d = decidir(base({ duda: { valor: true, motivo: 'no queda claro si prometió viabilidad del muro' } }), TRANSCRIPCION, ctx);
    expect(d.duda).toBe(true);
    expect(d.errores_criticos).toEqual([]);
    expect(d.escalado).toBe(true);
    expect(d.motivo_escalado).toContain('duda: no queda claro si prometió viabilidad del muro');
  });

  it('nota 88 sin errores ni dudas: apto y sin escalado (Ernesto no recibe nada)', () => {
    const d = decidir(base(), TRANSCRIPCION, ctx);
    expect(d).toMatchObject({ apto: true, escalado: false, motivo_escalado: null, duda: false });
  });
});

describe('Calificador · reglas críticas', () => {
  it('preguntar el presupuesto con el lead sin presupuesto registrado no es error (Alex, 02/11)', () => {
    const s = base({ errores_criticos: [{ regla: 'NO_PREGUNTAR', cita: '¿Y qué presupuesto tenéis más o menos para la obra?', marca_tiempo: '00:02:05' }] });
    const d = decidir(s, TRANSCRIPCION, ctx);
    expect(d.errores_criticos).toEqual([]);
    expect(d.errores_descartados[0].motivo).toBe('presupuesto no registrado: preguntarlo no es error');
    expect(d.apto).toBe(true);
    // Con el presupuesto registrado (P-05) sí es error crítico.
    expect(decidir(s, TRANSCRIPCION, { ...ctx, presupuestoRegistrado: true }).errores_criticos).toHaveLength(1);
  });

  it('LÍMITE PROFESIONAL por prometer viabilidad del muro', () => {
    const d = decidir(base({ errores_criticos: [{ regla: 'LIMITE_PROFESIONAL', cita: 'Sí, ese muro se puede tirar sin problema', marca_tiempo: '00:01:10' }] }), TRANSCRIPCION, ctx);
    expect(d.errores_criticos.map((e) => e.regla)).toEqual(['LIMITE_PROFESIONAL']);
    expect(d.motivo_escalado).toBe('error crítico: LÍMITE PROFESIONAL');
  });

  it('cita no verificable: el error se descarta, la llamada queda con duda y se escala', () => {
    const d = decidir(base({ errores_criticos: [{ regla: 'LIMITE_PROFESIONAL', cita: 'te confirmo que la licencia sale en una semana', marca_tiempo: '00:02:00' }] }), TRANSCRIPCION, ctx);
    expect(d.errores_criticos).toEqual([]);
    expect(d.errores_descartados[0].motivo).toBe('cita no encontrada en la transcripción');
    expect(d.duda).toBe(true);
    expect(d.escalado).toBe(true);
    expect(d.apto).toBe(true);
  });

  it('una cita literal admite cambios de mayúsculas, tildes y puntuación, pero no palabras distintas ni citas de 3 palabras', () => {
    expect(citaVerificable('si ese muro se puede TIRAR sin problema', TRANSCRIPCION)).toBe(true);
    expect(citaVerificable('ese muro se puede derribar sin problema', TRANSCRIPCION)).toBe(false);
    expect(citaVerificable('ya me dices', TRANSCRIPCION)).toBe(false);
  });
});

describe('Calificador · objeciones e ideas de marketing', () => {
  it('registra la objeción de plazo con su cita y su idea, sin datos personales', () => {
    const d = decidir(base({ objeciones: [
      { tipo: 'plazo', cita: 'Me da miedo que la obra se alargue meses.', idea_contenido: 'Vídeo: cómo cumplimos el plazo pactado' },
      { tipo: 'otra', cita: 'llámame al 612 345 678 cuando sepas algo', idea_contenido: null },
      { tipo: 'precio', cita: 'Me da miedo que la obra se alargue meses.', idea_contenido: 'Caso de [NOMBRE] en Alicante' },
    ] }), TRANSCRIPCION, ctx);
    expect(d.objeciones).toEqual([{ tipo: 'plazo', cita: 'Me da miedo que la obra se alargue meses.', idea_contenido: 'Vídeo: cómo cumplimos el plazo pactado' }]);
  });
});

describe('Calificador · anonimización previa al modelo', () => {
  it('nombre, teléfono, email y dirección viajan como marcadores', () => {
    const turnos = transcripcionPorTurnos([
      { speaker: 'cliente', start: 12, end: 15, text: 'Soy Lucía Fernández, mi móvil es 612 345 678 y mi correo lucia.f@gmail.com' },
      { speaker: 'agente', start: 65, end: 70, text: 'Perfecto Lucía, apunto calle Mayor 12, 3ºB' },
    ], '');
    const masked = enmascarar(turnos, ['Lucía Fernández']);
    expect(masked).not.toMatch(/Lucía|Fernández|612|lucia\.f@gmail\.com|Mayor 12/);
    expect(masked).toContain('[00:00:12] CLIENTE: Soy [NOMBRE]');
    expect(masked).toMatch(/\[TELÉFONO\].*\[EMAIL\]/);
    expect(masked).toContain('[DIRECCIÓN]');
    expect(marcaTiempo(3725)).toBe('01:02:05');
  });
});

describe('Calificador · salida del modelo', () => {
  it('rechaza una salida fuera de esquema', () => {
    expect(() => validarSalida('no es json')).toThrow(SalidaInvalida);
    expect(() => validarSalida(JSON.stringify({ ...base(), nota: 120 }))).toThrow(SalidaInvalida);
    expect(() => validarSalida(JSON.stringify({ ...base(), bien: ['solo uno'] }))).toThrow(SalidaInvalida);
    expect(() => validarSalida(JSON.stringify({ ...base(), errores_criticos: [{ regla: 'INVENTADA', cita: 'x', marca_tiempo: '' }] }))).toThrow(SalidaInvalida);
  });

  it('acepta una llamada no evaluable sin bien ni mejorar', () => {
    const s = validarSalida(JSON.stringify({ llamada_evaluable: false, motivo_no_evaluable: 'buzón de voz', nota: 0, errores_criticos: [], bien: [], mejorar: [], duda: { valor: false, motivo: null }, objeciones: [] }));
    expect(s).toMatchObject({ llamada_evaluable: false, motivo_no_evaluable: 'buzón de voz' });
  });

  it('pide a Gemini temperatura 0, la rúbrica versionada y el esquema JSON', async () => {
    let body: Record<string, any> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify(base()), usage: { total_input_tokens: 3100, total_output_tokens: 240 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const evaluar = evaluadorGemini({ GOOGLE_GEMINI_API_KEY: 'k', CALIFICADOR_MODEL: 'modelo-x' }, fetcher)!;
    const r = await evaluar(promptSistema(), promptUsuario({ rol: 'sdr', direccion: 'outbound', duracionSegundos: 240, presupuestoRegistrado: false, transcripcion: TRANSCRIPCION }));
    expect(body.generation_config.temperature).toBe(0);
    expect(body.model).toBe('modelo-x');
    expect(body.system_instruction).toContain('REGLA_CERO');
    expect(body.input).toContain('presupuesto_registrado: no');
    expect(body.response_format.schema.required).toContain('errores_criticos');
    expect(r).toMatchObject({ model: 'modelo-x', inputTokens: 3100, outputTokens: 240 });
    expect(evaluadorGemini({})).toBeNull();
  });
});

// --- Proceso con una base de datos simulada ---------------------------------------------------

type Query = { sql: string; params: unknown[] };
function fakePool(job: Record<string, unknown> | null) {
  const queries: Query[] = [];
  const client = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; }, release: () => undefined };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/SET estado = 'procesando'/.test(sql)) return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => client,
  };
  return { pool: pool as unknown as Pool, queries };
}
const CONFIG: ConfigCalificador = { supervisorNombre: 'Ernesto', supervisorWhatsapp: '+34600000000', dashboardUrl: 'https://ceo.grupolyn.com', envioActivo: true };
const JOB = { id: '7', llamada_id: '42', intentos: 1, rol: 'sdr', extension_netelip: '120', direction: 'outbound', duration_seconds: 240, occurred_at: new Date('2026-11-09T09:32:00Z'),
  t_status: 'completed', t_text: '', lead_name: 'Lucía Fernández', client_name: '',
  segments: [{ speaker: 'agente', start: 3, end: 8, text: 'Hola Lucía, soy Marta de Grupo LYN, te llamo por la reforma que nos pediste.' }, { speaker: 'cliente', start: 210, end: 214, text: 'Me da miedo que la obra se alargue meses.' }] };

describe('Calificador · proceso', () => {
  it('llamadas cortas, extensiones sin rol y eventos repetidos no crean evaluación (SQL)', async () => {
    const { pool, queries } = fakePool(null);
    await encolarEvaluacion(pool, 42);
    const { sql, params } = queries[0];
    expect(sql).toMatch(/JOIN comercial_rol r ON r\.extension_netelip = c\.agent_extension AND r\.activo/);
    expect(sql).toMatch(/c\.duration_seconds >= \$3/);
    expect(params[2]).toBe(60);
    // Una evaluación automática por llamada (las reevaluaciones bajo demanda no cuentan), con la rúbrica vigente.
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM llamada_evaluacion x WHERE x\.llamada_id = c\.id AND NOT x\.reevaluacion\s/);
    expect(sql).toMatch(/LEFT JOIN rubrica_version v ON v\.rol = r\.rol AND v\.activo/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('CAL-06: un closer sin rúbrica activa queda «no evaluada» con motivo; el SDR sin versión sigue con fase0-v1', async () => {
    for (const encolar of [(p: Pool) => encolarEvaluacion(p, 42), (p: Pool) => encolarPendientes(p)]) {
      const { pool, queries } = fakePool(null);
      await encolar(pool);
      const { sql } = queries[0];
      // Sin versión activa y rol distinto de sdr: no_evaluada y «sin rúbrica para el rol closer_f2».
      expect(sql).toMatch(/CASE WHEN \(v\.id IS NULL AND r\.rol <> 'sdr'\) OR .+ IS NOT NULL THEN 'no_evaluada' ELSE 'pendiente' END/);
      expect(sql).toMatch(/CASE WHEN \(v\.id IS NULL AND r\.rol <> 'sdr'\) THEN 'sin rúbrica para el rol ' \|\| r\.rol/);
      // Con versión activa, la fila la lleva; sin ella (SDR), NULL = fase0-v1.
      expect(sql).toMatch(/, v\.id\s+FROM netelip_calls c/);
      // Una «sin rúbrica» no impide encolarla cuando el rol estrene rúbrica.
      expect(sql).toMatch(/AND NOT \(x\.estado = 'no_evaluada' AND x\.rubrica_version_id IS NULL AND x\.motivo_no_evaluada LIKE 'sin rúbrica para el rol %'\)/);
    }
    expect(motivoSinRubrica('closer_f2')).toBe('sin rúbrica para el rol closer_f2');
  });

  it('evalúa: enmascara antes del modelo y guarda nota, decisión, feedback y objeciones', async () => {
    const { pool, queries } = fakePool({ ...JOB });
    let user = '';
    const evaluar = async (_s: string, u: string) => { user = u; return { text: JSON.stringify(base({ objeciones: [{ tipo: 'plazo', cita: 'Me da miedo que la obra se alargue meses.', idea_contenido: null }] })), model: 'm', inputTokens: 1, outputTokens: 1 }; };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('evaluada');
    expect(user).not.toContain('Lucía');
    expect(user).toContain('Hola [NOMBRE], soy Marta');
    const update = queries.find((q) => /SET estado = 'evaluada'/.test(q.sql))!;
    expect(update.params.slice(1, 3)).toEqual([88, true]);
    expect(String(update.params[11])).toMatch(/^Llamada 09\/11 10:32 \(4 min\): 88\/100 · APTO/);
    expect(queries.some((q) => /INSERT INTO objecion_marketing/.test(q.sql) && q.params[2] === 'plazo')).toBe(true);
  });

  it('el modelo falla 3 veces: queda «no evaluada» con el motivo y sin feedback', async () => {
    const { pool, queries } = fakePool({ ...JOB, intentos: MAX_INTENTOS });
    const evaluar = async () => { throw new Error('Gemini respondió HTTP 503'); };
    expect(await procesarSiguienteEvaluacion(pool, evaluar, CONFIG)).toBe('no_evaluada');
    const update = queries.find((q) => /SET estado = 'no_evaluada'/.test(q.sql))!;
    expect(String(update.params[1])).toBe('el modelo falló 3 veces: Gemini respondió HTTP 503');
    expect(queries.some((q) => /SET estado = 'evaluada'/.test(q.sql))).toBe(false);
  });

  it('un fallo antes del tercer intento reprograma con espera', async () => {
    const { pool, queries } = fakePool({ ...JOB, intentos: 1 });
    expect(await procesarSiguienteEvaluacion(pool, async () => ({ text: 'no json', model: 'm', inputTokens: null, outputTokens: null }), CONFIG)).toBe('reintento');
    expect(queries.some((q) => /SET estado = 'pendiente', proximo_intento = NOW\(\) \+ make_interval/.test(q.sql) && q.params[1] === 60)).toBe(true);
  });

  it('transcripción fallida: no evaluada sin llamar al modelo', async () => {
    const { pool } = fakePool({ ...JOB, t_status: 'failed' });
    let llamado = false;
    expect(await procesarSiguienteEvaluacion(pool, async () => { llamado = true; return { text: '', model: '', inputTokens: null, outputTokens: null }; }, CONFIG)).toBe('no_evaluada');
    expect(llamado).toBe(false);
  });

  it('el supervisor recibe el mismo feedback con el comercial y el enlace a la llamada', () => {
    expect(textoSupervisor('Llamada 09/11 10:32 (4 min): 72/100 · NO APTO', 'Marta', '120', '42', 'https://ceo.grupolyn.com/'))
      .toBe('Marta (ext. 120)\nLlamada 09/11 10:32 (4 min): 72/100 · NO APTO\nhttps://ceo.grupolyn.com/?view=netelip&call=42');
  });
});

describe('Calificador · recorte del feedback', () => {
  it('las líneas cortas ceden espacio a las largas y nunca se corta a mitad de palabra', () => {
    const largo = 'Explicas con precisión la diferencia entre el marco de inversión y el presupuesto cerrado tras el anteproyecto '.repeat(2).trim();
    const texto = textoFeedback({ cuando: '03/11 11:01', duracionSegundos: 1680, nota: 68, apto: false, bien: [largo, largo],
      mejorar: [{ que: 'Cierre abierto', accion: 'Fija día y hora' }, { que: 'Hablas mucho al inicio', accion: 'Pregunta primero por su proyecto' }],
      escalado: true, motivoEscalado: 'error crítico: REGLA CERO; nota inferior a 80', supervisor: 'Ernesto' });
    expect(texto.length).toBeLessThanOrEqual(FEEDBACK_MAX_CARACTERES);
    expect(texto).toContain('➡️ Cierre abierto: Fija día y hora');
    // La línea larga se recorta en un límite de palabra: lo que queda es un prefijo del original seguido de espacio.
    const bien = texto.split('\n')[1];
    const original = `✅ ${largo} · ${largo}`;
    expect(bien.endsWith('…')).toBe(true);
    const sinElipsis = bien.slice(0, -1);
    expect(original.startsWith(sinElipsis)).toBe(true);
    expect([' ', '·'].includes(original[sinElipsis.length]) || original.slice(sinElipsis.length).startsWith(' ')).toBe(true);
    expect(bien.length).toBeGreaterThan(200);
  });
});
