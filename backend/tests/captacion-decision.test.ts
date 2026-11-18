// N-1.4 · Decisión de pase: lógica pura (contrato de la IA, citas, comparación, escalado, entradas de personas y acierto).
import { describe, expect, it } from 'vitest';
import {
  calcularAcierto, compararDecisiones, DUDAS, EntradaInvalida, ETAPA_F2, EXCEPCIONES, generaDecision, leerDecisionIA, MAX_MOTIVOS, MAX_PASOS,
  motivoDeEscalado, motivoValido, requiereAFavor, validarEntradaDecision, validarPasosEditados, verificarDecisionIA,
  type CasoRevisado, type DecisionIA, type DecisionIABruta, type MotivosPorDecision, type PropuestaResumida,
} from '../netelip/captacion/decision.ts';

const MOTIVOS: MotivosPorDecision = {
  pasar_a_reunion: [{ codigo: 'cumple_criterios', etiqueta: 'Cumple los criterios' }],
  derivar_partners: [{ codigo: 'presupuesto_partners', etiqueta: 'Presupuesto de Partners' }],
  seguimiento: [{ codigo: 'falta_plano', etiqueta: 'Falta el plano' }, { codigo: 'pide_tiempo', etiqueta: 'Pide tiempo' }],
  descartar: [{ codigo: 'fuera_de_zona', etiqueta: 'Fuera de zona' }],
};

const TRANSCRIPCION = [
  '[00:00:05] GRUPO LYN: Hola, soy Laura de Grupo LYN.',
  '[00:00:30] CLIENTE: No tengo el plano ahora, te mando el plano cuando vuelva de vacaciones.',
  '[00:00:50] CLIENTE: Vuelvo el 20 de noviembre.',
  '[00:01:10] CLIENTE: Queremos un descuento del diez por ciento si cerramos esta semana.',
  '[00:01:40] CLIENTE: Hace falta que alguien venga a medir el terreno antes de nada.',
].join('\n');

const CITA_PLANO = 'te mando el plano cuando vuelva de vacaciones';
const CITA_VUELTA = 'Vuelvo el 20 de noviembre';

const bruta = (o: Partial<Record<keyof DecisionIABruta, unknown>> = {}): DecisionIABruta => ({
  decision: 'seguimiento',
  motivos: [{ codigo: 'falta_plano', cita: CITA_PLANO }],
  excepciones: [],
  dudas: [],
  pendienteErnesto: null,
  proximosPasos: [{
    orden: 1, accion: 'Llamar para pedir el plano', cuando: { tipo: 'fecha_cliente', valor: 'a partir del 20 de noviembre' }, canal: 'llamada',
    que_pedir: 'el plano', requiere_ernesto: false, cita: CITA_VUELTA,
  }],
  ...o,
});
const verificar = (o: Partial<Record<keyof DecisionIABruta, unknown>> = {}, motivos = MOTIVOS) => verificarDecisionIA(bruta(o), TRANSCRIPCION, motivos);
const bien = (o: Partial<Record<keyof DecisionIABruta, unknown>> = {}) => {
  const r = verificar(o);
  if (!r.ok) throw new Error(`debía valer: ${r.detalle}`);
  return r;
};

describe('leerDecisionIA', () => {
  it('sin objeto (o con algo que no lo es) no hay decisión de la IA', () => {
    for (const v of [undefined, null, 'x', 5, [], true]) expect(leerDecisionIA(v)).toBeNull();
  });
  it('lee los campos con los nombres del JSON del ticket', () => {
    const l = leerDecisionIA({ decision: 'seguimiento', motivos: [1], excepciones: ['descuento'], dudas: ['encaje_incierto'], pendiente_ernesto: { que_debe_decidir: 'x' }, proximos_pasos: [2] });
    expect(l).toEqual({ decision: 'seguimiento', motivos: [1], excepciones: ['descuento'], dudas: ['encaje_incierto'], pendienteErnesto: { que_debe_decidir: 'x' }, proximosPasos: [2] });
  });
});

describe('verificarDecisionIA · decisión y motivos', () => {
  it('Escenario «Próximos pasos en seguimiento»: «seguimiento», cita del plano y primer paso a partir del día 20 con su cita', () => {
    const { decision, descartes } = bien();
    expect(descartes).toEqual([]);
    expect(decision.decision).toBe('seguimiento');
    expect(decision.motivos).toEqual([{ codigo: 'falta_plano', texto: null, cita: CITA_PLANO }]);
    expect(decision.proximosPasos).toEqual([{
      orden: 1, accion: 'Llamar para pedir el plano', cuando: { tipo: 'fecha_cliente', valor: 'a partir del 20 de noviembre' }, canal: 'llamada',
      quePedir: 'el plano', requiereErnesto: false, cita: CITA_VUELTA,
    }]);
    expect(decision.pendienteErnesto).toBeNull();
  });

  it.each([undefined, null, 'ignorar', 'PASAR_A_REUNION', 3, ['seguimiento']])('una decisión que no es de las cuatro (%j) no es decisión de la IA', (d) => {
    expect(verificar({ decision: d })).toEqual({ ok: false, detalle: 'la decisión de la IA no es una de las cuatro posibles' });
  });

  it('acepta las cuatro decisiones', () => {
    for (const d of ['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar']) expect(bien({ decision: d }).decision.decision).toBe(d);
  });

  it('un motivo con una cita que no está en la llamada se descarta y consta', () => {
    const r = bien({ motivos: [{ codigo: 'falta_plano', cita: 'Dijo que sí a todo sin pensarlo mucho' }, { codigo: 'pide_tiempo', cita: CITA_PLANO }] });
    expect(r.decision.motivos.map((m) => m.codigo)).toEqual(['pide_tiempo']);
    expect(r.descartes).toEqual([{ campo: 'decision_ia.motivos.falta_plano', motivo: 'cita no encontrada en la transcripción' }]);
  });

  it('un motivo sin cita o con una cita corta (menos de 4 palabras) tampoco vale', () => {
    expect(bien({ motivos: [{ codigo: 'falta_plano', cita: null }] }).decision.motivos).toEqual([]);
    expect(bien({ motivos: [{ codigo: 'falta_plano', cita: 'el plano' }] }).decision.motivos).toEqual([]);
  });

  it('sin ningún motivo citable la decisión queda «Pendiente de Ernesto» con qué debe decidir', () => {
    const r = bien({ motivos: [{ codigo: 'falta_plano', cita: 'una frase inventada por el modelo para esto' }] });
    expect(r.decision.motivos).toEqual([]);
    expect(r.decision.pendienteErnesto).toEqual({ queDebeDecidir: 'La IA no pudo citar la llamada para justificar su decisión.' });
    expect(bien({ motivos: 'no es una lista' }).decision.pendienteErnesto).not.toBeNull();
  });

  it('si el modelo ya marcó «Pendiente de Ernesto», se respeta lo que dijo', () => {
    const r = bien({ pendienteErnesto: { que_debe_decidir: '  Decidir si el proyecto es viable para Partners ' } });
    expect(r.decision.pendienteErnesto).toEqual({ queDebeDecidir: 'Decidir si el proyecto es viable para Partners' });
    expect(bien({ pendienteErnesto: { que_debe_decidir: '' } }).decision.pendienteErnesto).toBeNull();
    expect(bien({ pendienteErnesto: 'algo' }).decision.pendienteErnesto).toBeNull();
  });

  it('un código que no está en la lista de esa decisión pasa a «otro» con su texto; uno de otra decisión también', () => {
    const r = bien({ motivos: [{ codigo: 'motivo_raro', cita: CITA_PLANO, texto: ' Pide ver una obra terminada ' }, { codigo: 'fuera_de_zona', cita: CITA_VUELTA }] });
    expect(r.decision.motivos).toEqual([
      { codigo: 'otro', texto: 'Pide ver una obra terminada', cita: CITA_PLANO },
      { codigo: 'otro', texto: 'fuera_de_zona', cita: CITA_VUELTA },
    ]);
  });

  it('«otro» explícito lleva su texto; sin texto se guarda el código que dijo el modelo', () => {
    expect(bien({ motivos: [{ codigo: 'otro', cita: CITA_PLANO, texto: 'Quiere esperar a la herencia' }] }).decision.motivos[0]).toMatchObject({ codigo: 'otro', texto: 'Quiere esperar a la herencia' });
    expect(bien({ motivos: [{ codigo: 'otro', cita: CITA_PLANO }] }).decision.motivos[0]).toMatchObject({ codigo: 'otro', texto: 'otro' });
  });

  it('el texto solo se guarda con «otro»', () => {
    expect(bien({ motivos: [{ codigo: 'falta_plano', cita: CITA_PLANO, texto: 'no debería guardarse' }] }).decision.motivos[0]!.texto).toBeNull();
  });

  it('un código repetido se cuenta una vez y hay como mucho 3 motivos', () => {
    const lista = ['falta_plano', 'falta_plano', 'pide_tiempo', 'x1', 'x2', 'x3'].map((codigo) => ({ codigo, cita: CITA_PLANO, texto: codigo }));
    const r = bien({ motivos: lista });
    expect(r.decision.motivos.map((m) => m.codigo)).toEqual(['falta_plano', 'pide_tiempo', 'otro']);
    expect(MAX_MOTIVOS).toBe(3);
  });

  it('lo que no es un objeto dentro de los motivos, o sin código, se ignora', () => {
    expect(bien({ motivos: [null, 5, 'x', { cita: CITA_PLANO }, { codigo: '   ', cita: CITA_PLANO }, { codigo: 'falta_plano', cita: CITA_PLANO }] }).decision.motivos).toHaveLength(1);
  });
});

describe('verificarDecisionIA · próximos pasos', () => {
  const paso = (o: Record<string, unknown> = {}) => ({
    orden: 9, accion: 'Llamar', cuando: { tipo: 'plazo_guion', valor: 'en una semana' }, canal: 'llamada', que_pedir: null, requiere_ernesto: false, cita: CITA_VUELTA, ...o,
  });

  it('numera los pasos desde 1 sin fiarse del orden que dijo el modelo', () => {
    const r = bien({ proximosPasos: [paso({ orden: 7, accion: 'Uno' }), paso({ orden: 2, accion: 'Dos' })] });
    expect(r.decision.proximosPasos.map((p) => [p.orden, p.accion])).toEqual([[1, 'Uno'], [2, 'Dos']]);
  });

  it('como mucho 3 pasos: el resto se descarta y consta', () => {
    const r = bien({ proximosPasos: [1, 2, 3, 4, 5].map((n) => paso({ accion: `Paso ${n}` })) });
    expect(r.decision.proximosPasos.map((p) => p.accion)).toEqual(['Paso 1', 'Paso 2', 'Paso 3']);
    expect(r.descartes).toEqual([{ campo: 'decision_ia.proximos_pasos', motivo: 'más de 3 pasos: se conservan los primeros' }]);
    expect(MAX_PASOS).toBe(3);
  });

  it('un paso sin cita verificable se descarta: cita obligatoria y verificada en cada paso', () => {
    const r = bien({ proximosPasos: [paso({ accion: 'Bueno' }), paso({ accion: 'Inventado', cita: 'una frase que nadie dijo en esta llamada' }), paso({ accion: 'Sin cita', cita: null })] });
    expect(r.decision.proximosPasos.map((p) => p.accion)).toEqual(['Bueno']);
    expect(r.descartes.filter((d) => d.motivo === 'cita no encontrada en la transcripción')).toHaveLength(2);
  });

  it('la cita de un paso puede ser de 3 palabras («Vuelvo el 20»), pero no de 2', () => {
    expect(bien({ proximosPasos: [paso({ cita: 'Vuelvo el 20' })] }).decision.proximosPasos).toHaveLength(1);
    expect(bien({ proximosPasos: [paso({ cita: 'Vuelvo el' })] }).decision.proximosPasos).toHaveLength(0);
  });

  it.each([
    ['sin acción', { accion: '  ' }],
    ['canal desconocido', { canal: 'telegrama' }],
    ['sin canal', { canal: undefined }],
    ['plazo de otro tipo', { cuando: { tipo: 'cuando_se_pueda', valor: 'x' } }],
    ['plazo sin valor', { cuando: { tipo: 'plazo_guion', valor: ' ' } }],
    ['sin plazo', { cuando: undefined }],
  ])('un paso incompleto o con datos no válidos (%s) se descarta', (_n, cambio) => {
    const r = bien({ proximosPasos: [paso(cambio as Record<string, unknown>)] });
    expect(r.decision.proximosPasos).toEqual([]);
    // Además del paso descartado, consta que la decisión se quedó sin ninguna recomendación.
    expect(r.descartes).toEqual([
      { campo: 'decision_ia.proximos_pasos', motivo: 'paso incompleto o con un canal o plazo no válido' },
      { campo: 'decision_ia.proximos_pasos', motivo: 'la decisión no trae ningún próximo paso verificable' },
    ]);
  });

  it('Escenario «Próximo paso que necesita una excepción»: el paso de la medición queda «requiere Ernesto»', () => {
    const r = bien({ proximosPasos: [paso({ accion: 'Medir el terreno', requiere_ernesto: true, que_pedir: 'topógrafo', cita: 'alguien venga a medir el terreno' })] });
    expect(r.decision.proximosPasos[0]).toMatchObject({ requiereErnesto: true, quePedir: 'topógrafo' });
    // Solo un «true» de verdad cuenta: un texto o un número no es una excepción.
    expect(bien({ proximosPasos: [paso({ requiere_ernesto: 'sí' })] }).decision.proximosPasos[0]!.requiereErnesto).toBe(false);
  });

  it('una decisión que no es «descartar» y se queda sin pasos verificables se guarda igual, con una nota; «descartar» sin pasos es normal', () => {
    const nota = { campo: 'decision_ia.proximos_pasos', motivo: 'la decisión no trae ningún próximo paso verificable' };
    for (const decision of ['pasar_a_reunion', 'derivar_partners', 'seguimiento']) {
      const r = bien({ decision, proximosPasos: [] });
      expect(r.decision.decision).toBe(decision);
      expect(r.descartes, decision).toEqual([nota]);
    }
    expect(bien({ decision: 'descartar', proximosPasos: [] }).descartes).toEqual([]);
    expect(bien({ proximosPasos: [paso()] }).descartes).toEqual([]);
  });

  it('los pasos que no son objetos se ignoran; sin lista, no hay pasos', () => {
    expect(bien({ proximosPasos: [null, 3, 'x', paso()] }).decision.proximosPasos).toHaveLength(1);
    expect(bien({ proximosPasos: undefined }).decision.proximosPasos).toEqual([]);
  });

  it('el paso no crea ningún aviso, tarea ni mensaje: es solo un dato de la decisión (sin acciones automáticas)', () => {
    const r = bien({ proximosPasos: [paso({ accion: 'Llamar en una semana' })] });
    expect(Object.keys(r.decision.proximosPasos[0]!).sort()).toEqual(['accion', 'canal', 'cita', 'cuando', 'orden', 'quePedir', 'requiereErnesto']);
  });
});

describe('verificarDecisionIA · excepciones y dudas', () => {
  it('Escenario «Excepción económica»: conserva las excepciones conocidas, sin repetir, e ignora las desconocidas', () => {
    const r = bien({ excepciones: ['descuento', 'descuento', 'regalo', 'topografo', 5] });
    expect(r.decision.excepciones).toEqual(['descuento', 'topografo']);
    expect(EXCEPCIONES).toEqual(['descuento', 'condiciones_pago', 'topografo', 'fuera_de_zona', 'videollamada', 'sin_decisor']);
  });
  it('conserva las dudas conocidas', () => {
    expect(bien({ dudas: ['presupuesto_limite', 'otra', 'presupuesto_limite'] }).decision.dudas).toEqual(['presupuesto_limite']);
    expect(DUDAS).toEqual(['presupuesto_limite', 'encaje_incierto', 'viabilidad_tecnica']);
  });
  it('sin listas, quedan vacías', () => {
    const r = bien({ excepciones: 'descuento', dudas: undefined });
    expect([r.decision.excepciones, r.decision.dudas]).toEqual([[], []]);
  });
});

describe('motivoDeEscalado y comparación', () => {
  const ia = (o: Partial<Pick<DecisionIA, 'excepciones' | 'dudas' | 'pendienteErnesto' | 'proximosPasos'>> = {}) => ({ excepciones: [], dudas: [], pendienteErnesto: null, proximosPasos: [], ...o });
  const pasoEx = { orden: 1, accion: 'Medir', cuando: { tipo: 'plazo_guion' as const, valor: 'x' }, canal: 'llamada' as const, quePedir: null, requiereErnesto: true, cita: null };

  it('Escenario «Acuerdo durante el piloto»: si coinciden y no hay nada más, el motivo es «piloto»', () => {
    expect(motivoDeEscalado(true, ia())).toBe('piloto');
  });
  it('Escenario «Discrepancia»: si no coinciden, «discrepancia», pase lo que pase con lo demás', () => {
    expect(motivoDeEscalado(false, ia())).toBe('discrepancia');
    expect(motivoDeEscalado(false, ia({ excepciones: ['descuento'], dudas: ['encaje_incierto'] }))).toBe('discrepancia');
  });
  it('Escenario «Excepción económica»: coincidan o no, una excepción manda sobre la duda y sobre el piloto', () => {
    expect(motivoDeEscalado(true, ia({ excepciones: ['descuento'] }))).toBe('excepcion');
    expect(motivoDeEscalado(true, ia({ excepciones: ['descuento'], dudas: ['encaje_incierto'], pendienteErnesto: { queDebeDecidir: 'x' } }))).toBe('excepcion');
  });
  it('un paso que «requiere Ernesto» también es una excepción', () => {
    expect(motivoDeEscalado(true, ia({ proximosPasos: [pasoEx] }))).toBe('excepcion');
    expect(motivoDeEscalado(true, ia({ proximosPasos: [{ ...pasoEx, requiereErnesto: false }] }))).toBe('piloto');
  });
  it('una duda, o un «Pendiente de Ernesto», es «duda»', () => {
    expect(motivoDeEscalado(true, ia({ dudas: ['presupuesto_limite'] }))).toBe('duda');
    expect(motivoDeEscalado(true, ia({ pendienteErnesto: { queDebeDecidir: 'Decidir encaje' } }))).toBe('duda');
  });

  const prop = (decision: PropuestaResumida['decision'], motivoCodigo: string | null): PropuestaResumida => ({ decision, motivoCodigo });
  it('coinciden solo si lo hacen en la decisión Y en el motivo; la misma decisión con otro motivo es una discrepancia', () => {
    expect(compararDecisiones(prop('seguimiento', 'falta_plano'), prop('seguimiento', 'falta_plano'))).toEqual({ coincide: true, mismaDecision: true });
    expect(compararDecisiones(prop('seguimiento', 'falta_plano'), prop('seguimiento', 'pide_tiempo'))).toEqual({ coincide: false, mismaDecision: true });
    expect(compararDecisiones(prop('descartar', 'x'), prop('derivar_partners', 'x'))).toEqual({ coincide: false, mismaDecision: false });
    expect(compararDecisiones(prop('seguimiento', null), prop('seguimiento', null))).toEqual({ coincide: true, mismaDecision: true });
    expect(compararDecisiones(prop('seguimiento', 'a'), prop('seguimiento', null))).toEqual({ coincide: false, mismaDecision: true });
  });
  it('hay que decir con quién se está de acuerdo salvo que coincidan en decisión Y motivo', () => {
    expect(requiereAFavor({ coincide: true, mismaDecision: true })).toBe(false);
    expect(requiereAFavor({ coincide: false, mismaDecision: true })).toBe(true);
    expect(requiereAFavor({ coincide: false, mismaDecision: false })).toBe(true);
  });
});

describe('Escenario «Solo decisiones de pase del SDR»: la fase del lead', () => {
  it('un lead en F2 (e4) o más allá no genera decisión; antes de F2 sí; sin etapa conocida sí', () => {
    expect(ETAPA_F2).toBe(4);
    for (const e of [1, 2, 3]) expect(generaDecision(e), `e${e}`).toBe(true);
    for (const e of [4, 5, 9, 14, 16, 18]) expect(generaDecision(e), `e${e}`).toBe(false);
    expect(generaDecision(null)).toBe(true);
  });
});

describe('entradas de personas', () => {
  const ok = { decision: 'seguimiento', motivo_codigo: 'falta_plano', dato_cita: 'Dijo que manda el plano al volver' };

  it('acepta una propuesta completa y recoge los espacios', () => {
    expect(validarEntradaDecision({ ...ok, dato_cita: '  Dijo que   manda el plano ' }, MOTIVOS)).toEqual({
      decision: 'seguimiento', motivoCodigo: 'falta_plano', motivoTexto: null, datoCita: 'Dijo que manda el plano',
    });
  });
  it('«otro» exige decir cuál; con un motivo de la lista el texto se ignora', () => {
    expect(() => validarEntradaDecision({ ...ok, motivo_codigo: 'otro' }, MOTIVOS)).toThrow('Con el motivo «otro» hay que escribir cuál.');
    expect(validarEntradaDecision({ ...ok, motivo_codigo: 'otro', motivo_texto: 'Quiere esperar' }, MOTIVOS)).toMatchObject({ motivoCodigo: 'otro', motivoTexto: 'Quiere esperar' });
    expect(validarEntradaDecision({ ...ok, motivo_texto: 'no cuenta' }, MOTIVOS).motivoTexto).toBeNull();
  });
  it.each([
    ['sin cuerpo', undefined, 'La decisión debe ser'],
    ['una decisión inventada', { ...ok, decision: 'esperar' }, 'La decisión debe ser'],
    ['sin motivo', { ...ok, motivo_codigo: '' }, 'El motivo debe ser uno de la lista'],
    ['un motivo de otra decisión', { ...ok, motivo_codigo: 'fuera_de_zona' }, 'El motivo debe ser uno de la lista'],
    ['sin dato ni cita', { ...ok, dato_cita: '  ' }, 'Falta el dato de la llamada'],
    ['un dato larguísimo', { ...ok, dato_cita: 'x'.repeat(1001) }, 'no pueden pasar de 1000'],
    ['un motivo escrito larguísimo', { ...ok, motivo_codigo: 'otro', motivo_texto: 'y'.repeat(1001) }, 'no pueden pasar de 1000'],
  ])('rechaza: %s', (_n, entrada, mensaje) => {
    expect(() => validarEntradaDecision(entrada, MOTIVOS)).toThrow(EntradaInvalida);
    expect(() => validarEntradaDecision(entrada, MOTIVOS)).toThrow(mensaje);
  });
  it('1000 caracteres justos valen', () => {
    expect(validarEntradaDecision({ ...ok, dato_cita: 'x'.repeat(1000) }, MOTIVOS).datoCita).toHaveLength(1000);
  });
  it('el motivo se valida contra la lista que se le pasa (configurable, no contra una fija)', () => {
    const otra: MotivosPorDecision = { ...MOTIVOS, seguimiento: [{ codigo: 'nuevo_motivo', etiqueta: 'Nuevo' }] };
    expect(() => validarEntradaDecision(ok, otra)).toThrow('El motivo debe ser uno de la lista');
    expect(validarEntradaDecision({ ...ok, motivo_codigo: 'nuevo_motivo' }, otra).motivoCodigo).toBe('nuevo_motivo');
    expect(motivoValido(otra, 'seguimiento', 'otro')).toBe(true);
  });

  const paso = { accion: 'Llamar', cuando: { tipo: 'plazo_guion', valor: 'en una semana' }, canal: 'whatsapp', que_pedir: 'plano', requiere_ernesto: true, cita: null };
  it('los pasos que edita Ernesto: sin lista no hay pasos, se numeran, y exigen acción, plazo y canal', () => {
    expect(validarPasosEditados(undefined)).toEqual([]);
    expect(validarPasosEditados(null)).toEqual([]);
    expect(validarPasosEditados([paso, { ...paso, accion: 'Dos' }]).map((p) => [p.orden, p.accion, p.canal, p.requiereErnesto, p.quePedir])).toEqual([[1, 'Llamar', 'whatsapp', true, 'plano'], [2, 'Dos', 'whatsapp', true, 'plano']]);
    expect(() => validarPasosEditados('x')).toThrow(EntradaInvalida);
    expect(() => validarPasosEditados([paso, paso, paso, paso])).toThrow('hasta 3');
    expect(() => validarPasosEditados([{ ...paso, canal: 'paloma' }])).toThrow('El próximo paso 1 está incompleto');
    expect(() => validarPasosEditados([paso, { ...paso, accion: '' }])).toThrow('El próximo paso 2 está incompleto');
    expect(() => validarPasosEditados([null])).toThrow(EntradaInvalida);
  });
});

describe('calcularAcierto', () => {
  const p = (decision: PropuestaResumida['decision'], motivoCodigo: string | null = 'm'): PropuestaResumida => ({ decision, motivoCodigo });
  const caso = (o: Partial<CasoRevisado> = {}): CasoRevisado => ({ origen: 'nuevo', estado: 'validada', coincide: true, sdr: p('seguimiento'), ia: p('seguimiento'), final: p('seguimiento'), ...o });
  const fila = (casos: CasoRevisado[], actor: 'coincidentes' | 'sdr' | 'ia') => calcularAcierto(casos).find((f) => f.actor === actor)!;

  it('Escenario «Medición del acierto»: 10 casos coincidentes nuevos revisados y 9 confirmados dan un 90 % con 10 casos', () => {
    const casos = [...Array.from({ length: 9 }, () => caso()), caso({ estado: 'corregida', final: p('descartar') })];
    expect(fila(casos, 'coincidentes')).toEqual({ actor: 'coincidentes', revisados: 10, aciertos: 9, porcentaje: 90 });
  });
  it('Escenario «El histórico no cuenta para el acierto»: 50 casos históricos no suman casos revisados', () => {
    const casos = [...Array.from({ length: 50 }, () => caso({ origen: 'historico' })), caso()];
    expect(fila(casos, 'coincidentes')).toEqual({ actor: 'coincidentes', revisados: 1, aciertos: 1, porcentaje: 100 });
    expect(fila(casos, 'sdr').revisados).toBe(1);
    expect(fila(casos, 'ia').revisados).toBe(1);
  });
  it('un caso pendiente de Ernesto no cuenta como revisado', () => {
    const casos = [caso({ estado: 'pendiente_ernesto', final: null }), caso({ estado: 'pendiente_ernesto', final: p('seguimiento') })];
    expect(calcularAcierto(casos).map((f) => [f.actor, f.revisados, f.porcentaje])).toEqual([['coincidentes', 0, null], ['sdr', 0, null], ['ia', 0, null]]);
  });
  it('sin casos no hay porcentaje (no es un 0 %)', () => {
    expect(calcularAcierto([])).toEqual([
      { actor: 'coincidentes', revisados: 0, aciertos: 0, porcentaje: null },
      { actor: 'sdr', revisados: 0, aciertos: 0, porcentaje: null },
      { actor: 'ia', revisados: 0, aciertos: 0, porcentaje: null },
    ]);
  });
  it('los casos en que SDR e IA no coincidieron no entran en «coincidentes», pero sí en el acierto de cada actor', () => {
    const casos = [
      caso({ coincide: false, estado: 'validada', sdr: p('descartar'), ia: p('derivar_partners'), final: p('derivar_partners') }),
      caso({ coincide: false, estado: 'corregida', sdr: p('descartar'), ia: p('derivar_partners'), final: p('seguimiento') }),
      caso(),
    ];
    expect(fila(casos, 'coincidentes')).toMatchObject({ revisados: 1, aciertos: 1, porcentaje: 100 });
    expect(fila(casos, 'sdr')).toMatchObject({ revisados: 3, aciertos: 1, porcentaje: 33 });
    expect(fila(casos, 'ia')).toMatchObject({ revisados: 3, aciertos: 2, porcentaje: 67 });
  });
  it('el acierto de un actor exige decisión Y motivo: la misma decisión con otro motivo no cuenta', () => {
    const casos = [caso({ sdr: p('seguimiento', 'falta_plano'), ia: p('seguimiento', 'pide_tiempo'), final: p('seguimiento', 'pide_tiempo') })];
    expect(fila(casos, 'sdr').aciertos).toBe(0);
    expect(fila(casos, 'ia').aciertos).toBe(1);
  });
  it('el porcentaje se redondea al entero', () => {
    const casos = [caso(), caso(), caso({ estado: 'corregida', final: p('descartar') })];
    expect(fila(casos, 'coincidentes').porcentaje).toBe(67);
  });
});
