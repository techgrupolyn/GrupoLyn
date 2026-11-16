import { describe, expect, it } from 'vitest';
import {
  calcularCategoria,
  nivelAlcanceProvisional,
  nivelesVigentes,
  nivelUrgencia,
  nivelVigente,
  noAptoVigente,
  type EvaluacionCriterio,
  type EventoNoApto,
} from '../netelip/captacion/agregacion.ts';
import { AGREGACION_V1, CRITERIOS_IDS, MATRIZ_V1, type CriterioConfig, type CriterioId, type NivelONE } from '../netelip/captacion/matriz.ts';

const niv = (parcial: Partial<Record<CriterioId, NivelONE>> = {}): Record<CriterioId, NivelONE> => {
  const todos = {} as Record<CriterioId, NivelONE>;
  for (const id of CRITERIOS_IDS) todos[id] = parcial[id] ?? 'NE';
  return todos;
};
const todosA = (resto: Partial<Record<CriterioId, NivelONE>> = {}) =>
  niv({ presupuesto: 'A', urgencia: 'A', decisor: 'A', alcance: 'A', actitud: 'A', encaje_lyn: 'A', predisposicion_f2f3: 'A', ...resto });
const calc = (niveles: Record<CriterioId, NivelONE>, extra: { noApto?: boolean; presupuestoVigente?: number | null } = {}) =>
  calcularCategoria({ niveles, noApto: extra.noApto ?? false, presupuestoVigente: extra.presupuestoVigente ?? null });

const ev = (extra: Partial<EvaluacionCriterio> & Pick<EvaluacionCriterio, 'nivel'>): EvaluacionCriterio => ({
  criterioId: 'urgencia',
  origen: 'llamada',
  cita: 'Queremos empezar en unos cuatro meses',
  fechaInteraccion: '2026-11-10T10:00:00Z',
  creadoEn: '2026-11-10T10:05:00Z',
  ...extra,
});

describe('matriz de Alex (v1)', () => {
  it('los 7 pesos suman 100 y siguen el orden del ticket', () => {
    expect(MATRIZ_V1.map((c) => [c.criterioId, c.peso])).toEqual([
      ['presupuesto', 25], ['urgencia', 25], ['decisor', 15], ['alcance', 10], ['actitud', 10], ['encaje_lyn', 10], ['predisposicion_f2f3', 5],
    ]);
    expect(MATRIZ_V1.reduce((n, c) => n + c.peso, 0)).toBe(100);
  });
});

describe('Escenario: categoría global calculada por la matriz', () => {
  const niveles = niv({ presupuesto: 'A', urgencia: nivelUrgencia(4), decisor: 'A', alcance: 'B', actitud: 'A', encaje_lyn: 'C' });

  it('Urgencia de 4 meses queda en B y Predisposición F2/F3 en NE', () => {
    expect(niveles.urgencia).toBe('B');
    expect(niveles.predisposicion_f2f3).toBe('NE');
  });
  it('la puntuación es 3,42, la cobertura 95 % y la categoría B', () => {
    const r = calc(niveles);
    expect(r.puntuacion).toBe(3.42);
    expect(r.cobertura).toBe(95);
    expect(r.categoria).toBe('B');
    expect(r.motivo).toBe('puntuacion');
  });
  it('el desglose muestra los 7 niveles, la puntuación y la cobertura', () => {
    expect(calc(niveles).desglose).toBe('Pres A · Urg B · Dec A · Alc B · Act A · Enc C · F2/F3 NE · 3,42 · cob. 95 %');
  });
});

describe('Escenario: NE no penaliza', () => {
  it('todo A salvo F2/F3 en NE da 4,00 y categoría A', () => {
    const r = calc(todosA({ predisposicion_f2f3: 'NE' }));
    expect(r.puntuacion).toBe(4);
    expect(r.categoria).toBe('A');
    expect(r.cobertura).toBe(95);
  });
});

describe('Escenario: cobertura insuficiente', () => {
  it('solo Presupuesto y Decisor (40 %) queda sin calificar, aunque sean A', () => {
    const r = calc(niv({ presupuesto: 'A', decisor: 'A' }));
    expect(r.categoria).toBe('sin_calificar');
    expect(r.motivo).toBe('cobertura_insuficiente');
    expect(r.cobertura).toBe(40);
  });
  it('exactamente 50 % ya califica (el mínimo es «menor del 50 %»)', () => {
    const r = calc(niv({ presupuesto: 'A', urgencia: 'A' }));
    expect(r.cobertura).toBe(50);
    expect(r.categoria).toBe('A');
  });
  it('un lead sin ninguna evaluación queda sin calificar, sin puntuación y con cobertura 0', () => {
    const r = calc(niv());
    expect(r.categoria).toBe('sin_calificar');
    expect(r.puntuacion).toBeNull();
    expect(r.cobertura).toBe(0);
    expect(r.desglose).toBe('Pres NE · Urg NE · Dec NE · Alc NE · Act NE · Enc NE · F2/F3 NE · – · cob. 0 %');
  });
});

describe('cortes de la puntuación', () => {
  it('3,50 exacto es A (Urgencia C y el resto A)', () => {
    const r = calc(todosA({ urgencia: 'C' }));
    expect(r.puntuacion).toBe(3.5);
    expect(r.categoria).toBe('A');
  });
  it('3,45 es B (Urgencia C y F2/F3 B)', () => {
    const r = calc(todosA({ urgencia: 'C', predisposicion_f2f3: 'B' }));
    expect(r.puntuacion).toBe(3.45);
    expect(r.categoria).toBe('B');
  });
  it('2,50 exacto es B y 1,50 exacto es C', () => {
    // Urgencia D y Presupuesto D (50 puntos de peso en 1) y el resto A: (50*1 + 50*4)/100 = 2,50.
    const b = calc(todosA({ presupuesto: 'D', urgencia: 'D' }));
    expect(b.puntuacion).toBe(2.5);
    expect(b.categoria).toBe('B');
    // Todo D salvo Decisor, Alcance, Actitud, Encaje (45 %) en C... (55*1 + 45*2)/100 = 1,45 → D; con F2/F3 en C da 1,5.
    const casiC = calc(niv({ presupuesto: 'D', urgencia: 'D', decisor: 'C', alcance: 'C', actitud: 'C', encaje_lyn: 'C', predisposicion_f2f3: 'D' }));
    expect(casiC.puntuacion).toBe(1.45);
    expect(casiC.categoria).toBe('D');
    const c = calc(niv({ presupuesto: 'D', urgencia: 'D', decisor: 'C', alcance: 'C', actitud: 'C', encaje_lyn: 'C', predisposicion_f2f3: 'C' }));
    expect(c.puntuacion).toBe(1.5);
    expect(c.categoria).toBe('C');
  });
  it('todo D es D y todo C es C', () => {
    expect(calc(niv(Object.fromEntries(CRITERIOS_IDS.map((i) => [i, 'D'])) as Record<CriterioId, NivelONE>)).categoria).toBe('D');
    expect(calc(niv(Object.fromEntries(CRITERIOS_IDS.map((i) => [i, 'C'])) as Record<CriterioId, NivelONE>)).categoria).toBe('C');
  });
  it('decide con el valor exacto, no con el redondeado: 3,4975 se muestra 3,50 pero es B', () => {
    const matriz: CriterioConfig[] = MATRIZ_V1.map((c) =>
      c.criterioId === 'presupuesto' ? { ...c, peso: 99 } : c.criterioId === 'urgencia' ? { ...c, peso: 100 } : { ...c, peso: 0 },
    );
    const r = calcularCategoria({ niveles: niv({ presupuesto: 'A', urgencia: 'B' }), noApto: false, presupuestoVigente: null, matriz });
    expect(r.puntuacion).toBe(3.5);
    expect(r.categoria).toBe('B');
  });
});

describe('No apto', () => {
  it('manda sobre todo, aunque el resto sea A', () => {
    const r = calc(todosA(), { noApto: true, presupuestoVigente: 500000 });
    expect(r.categoria).toBe('no_apto');
    expect(r.motivo).toBe('no_apto');
    expect(r.puntuacion).toBe(4);
  });
  it('un lead sin evaluaciones con No apto también es no_apto', () => {
    expect(calc(niv(), { noApto: true }).categoria).toBe('no_apto');
  });
});

describe('A+', () => {
  it('A con presupuesto vigente de 100.000 € y criterio Presupuesto en A es A+', () => {
    expect(calc(todosA(), { presupuestoVigente: 100000 }).categoria).toBe('A+');
  });
  it('99.999 € se queda en A', () => {
    expect(calc(todosA(), { presupuestoVigente: 99999 }).categoria).toBe('A');
  });
  it('con el criterio Presupuesto en B también es A+', () => {
    const r = calc(todosA({ presupuesto: 'B' }), { presupuestoVigente: 250000 });
    expect(r.puntuacion).toBe(3.75);
    expect(r.categoria).toBe('A+');
  });
  it('con el criterio Presupuesto en C no es A+, aunque el importe sea alto', () => {
    const r = calc(todosA({ presupuesto: 'C', urgencia: 'A' }), { presupuestoVigente: 300000 });
    expect(r.categoria).toBe('A');
    expect(r.aPlusPermitido).toBe(false);
  });
  it('con el criterio Presupuesto en NE no es A+', () => {
    const r = calc(todosA({ presupuesto: 'NE' }), { presupuestoVigente: 300000 });
    expect(r.categoria).toBe('A');
    expect(r.aPlusPermitido).toBe(false);
  });
  it('sin presupuesto vigente no es A+', () => {
    expect(calc(todosA(), { presupuestoVigente: null }).categoria).toBe('A');
  });
  it('una B con presupuesto alto sigue siendo B', () => {
    expect(calc(todosA({ presupuesto: 'C', urgencia: 'D' }), { presupuestoVigente: 900000 }).categoria).toBe('B');
  });
});

describe('Urgencia determinista (P-11)', () => {
  it.each([
    [0, 'A'], [3, 'A'], [3.1, 'B'], [6, 'B'], [6.5, 'C'], [12, 'C'], [12.1, 'D'], [36, 'D'],
  ])('%s meses → %s', (meses, esperado) => {
    expect(nivelUrgencia(meses as number)).toBe(esperado);
  });
  it('sin plazo, negativo o no numérico es NE', () => {
    expect(nivelUrgencia(null)).toBe('NE');
    expect(nivelUrgencia(undefined)).toBe('NE');
    expect(nivelUrgencia(-1)).toBe('NE');
    expect(nivelUrgencia(Number.NaN)).toBe('NE');
    expect(nivelUrgencia('3' as unknown as number)).toBe('NE');
  });
});

describe('Alcance provisional con los valores REALES de ClickUp (lista «Contacto de Reforma», 12/11/2026)', () => {
  it.each([
    // Tipo de Contacto (2.060 de 2.066 leads lo traen): con guiones bajos y, el último, con una explicación detrás.
    [{ tipoContacto: 'Reforma_integral_de_vivienda' }, 'A'],
    [{ tipoContacto: 'Reforma_global_de_vivienda_(salvo_algunas_estancias)' }, 'C'],
    [{ tipoContacto: 'Reforma_de_una_estancia_concreta:_cocina,_baño_u_otra_zona' }, 'D'],
    // Tipo de Contacto que no dice el alcance: no se mapean (NE), no se inventa.
    [{ tipoContacto: 'REFORMA' }, 'NE'],
    [{ tipoContacto: 'OBRA NUEVA' }, 'NE'],
    [{ tipoContacto: 'INTERIORISMO' }, 'NE'],
    [{ tipoContacto: 'CAMBIO DE USO' }, 'NE'],
    [{ tipoContacto: 'PROVEEDOR' }, 'NE'],
    // tipo_reforma (solo 210 leads): «Parcial» no está definido en el ticket y queda en NE.
    [{ tipoReforma: 'Integral' }, 'A'],
    [{ tipoReforma: 'Especifica' }, 'D'],
    [{ tipoReforma: 'Parcial' }, 'NE'],
    [{ tipoReforma: 'Reforma integral de vivienda' }, 'A'],
    [{ tipoReforma: 'Reforma global de vivienda (salvo algunas estancias)' }, 'C'],
    // Los dos campos a la vez: manda tipo_reforma si se reconoce; si no, el tipo de contacto.
    [{ tipoReforma: 'Parcial', tipoContacto: 'Reforma_integral_de_vivienda' }, 'A'],
    [{ tipoReforma: 'Especifica', tipoContacto: 'Reforma_integral_de_vivienda' }, 'D'],
  ])('%j → %s', (datos, esperado) => {
    expect(nivelAlcanceProvisional(datos)).toBe(esperado);
  });
  it('una clave más corta no se come a la más larga («integral» no captura «reforma integral de vivienda»)', () => {
    expect(nivelAlcanceProvisional({ tipoContacto: 'Integral de lujo' })).toBe('A');
    expect(nivelAlcanceProvisional({ tipoContacto: 'Reformaintegral' })).toBe('NE');
    expect(nivelAlcanceProvisional({ tipoContacto: 'No es integral' })).toBe('NE');
  });
});

describe('Escenario: Alcance provisional desde el formulario', () => {
  it.each([
    [{ tipoContacto: 'Reforma integral de vivienda' }, 'A'],
    [{ tipoReforma: 'Reforma integral de vivienda' }, 'A'],
    [{ tipoContacto: 'Integral' }, 'A'],
    [{ tipoReforma: 'Reforma global de vivienda (salvo algunas estancias)' }, 'C'],
    [{ tipoReforma: 'Reforma de una estancia concreta' }, 'D'],
    [{ tipoContacto: 'Específica' }, 'D'],
    [{ tipoContacto: '  REFORMA   INTEGRAL de vivienda ' }, 'A'],
    [{ tipoContacto: 'Otra cosa' }, 'NE'],
    [{}, 'NE'],
  ])('%j → %s', (datos, esperado) => {
    expect(nivelAlcanceProvisional(datos)).toBe(esperado);
  });
  it('manda el tipo de reforma sobre el tipo de contacto', () => {
    expect(nivelAlcanceProvisional({ tipoReforma: 'Reforma de una estancia concreta', tipoContacto: 'Integral' })).toBe('D');
  });
  it('si el tipo de reforma no se reconoce, usa el tipo de contacto', () => {
    expect(nivelAlcanceProvisional({ tipoReforma: 'Otra', tipoContacto: 'Integral' })).toBe('A');
  });
  it('no confunde propiedades heredadas de los objetos con una correspondencia', () => {
    expect(nivelAlcanceProvisional({ tipoContacto: 'constructor' })).toBe('NE');
  });
});

describe('nivel vigente por criterio', () => {
  it('Escenario: una llamada sin información no borra lo evaluado', () => {
    const anterior = ev({ nivel: 'B', fechaInteraccion: '2026-11-05T10:00:00Z' });
    const sinInfo = ev({ nivel: 'NE', cita: null, fechaInteraccion: '2026-11-09T10:00:00Z' });
    expect(nivelVigente([anterior, sinInfo])).toBe('B');
  });
  it('manda la llamada más reciente por FECHA de la interacción, no por cuándo se procesó', () => {
    const nueva = ev({ nivel: 'A', fechaInteraccion: '2026-11-09T10:00:00Z', creadoEn: '2026-11-09T10:05:00Z' });
    const vieja = ev({ nivel: 'D', fechaInteraccion: '2026-11-01T10:00:00Z', creadoEn: '2026-11-11T09:00:00Z' });
    expect(nivelVigente([nueva, vieja])).toBe('A');
    expect(nivelVigente([vieja, nueva])).toBe('A');
  });
  it('con la misma fecha desempata por creado_en', () => {
    const a = ev({ nivel: 'A', creadoEn: '2026-11-10T10:05:00Z' });
    const b = ev({ nivel: 'C', creadoEn: '2026-11-10T10:09:00Z' });
    expect(nivelVigente([a, b])).toBe('C');
  });
  it('Escenario: la primera evidencia citada de una llamada sustituye al nivel provisional', () => {
    const provisional = ev({ criterioId: 'alcance', nivel: 'A', origen: 'formulario_provisional', cita: null });
    expect(nivelVigente([provisional])).toBe('A');
    const llamada = ev({ criterioId: 'alcance', nivel: 'C', fechaInteraccion: '2026-11-10T11:00:00Z' });
    expect(nivelVigente([provisional, llamada])).toBe('C');
  });
  it('el provisional sigue valiendo si la llamada no aporta información (NE)', () => {
    const provisional = ev({ criterioId: 'alcance', nivel: 'A', origen: 'formulario_provisional', cita: null });
    const llamada = ev({ criterioId: 'alcance', nivel: 'NE', cita: null });
    expect(nivelVigente([provisional, llamada])).toBe('A');
  });
  it('un nivel de llamada sin cita no cuenta', () => {
    expect(nivelVigente([ev({ nivel: 'A', cita: null })])).toBe('NE');
    expect(nivelVigente([ev({ nivel: 'A', cita: '   ' })])).toBe('NE');
  });
  it('sin evaluaciones es NE', () => {
    expect(nivelVigente([])).toBe('NE');
  });
  it('nivelesVigentes separa por criterio y rellena con NE los que faltan', () => {
    const r = nivelesVigentes([
      ev({ criterioId: 'urgencia', nivel: 'B' }),
      ev({ criterioId: 'decisor', nivel: 'C' }),
      ev({ criterioId: 'decisor', nivel: 'A', fechaInteraccion: '2026-11-11T10:00:00Z' }),
    ]);
    expect(r).toEqual(niv({ urgencia: 'B', decisor: 'A' }));
  });
});

describe('No apto vigente', () => {
  const ia = (valor: boolean, cita: string | null, fecha: string): EventoNoApto => ({
    valor, cita, registradoPor: 'ia', fechaInteraccion: fecha, creadoEn: fecha,
  });
  const usuario = (valor: boolean, fecha: string): EventoNoApto => ({
    valor, cita: null, registradoPor: 'usuario', fechaInteraccion: fecha, creadoEn: fecha,
  });
  it('sin eventos no hay No apto', () => {
    expect(noAptoVigente([])).toBe(false);
  });
  it('la IA lo marca con cita', () => {
    expect(noAptoVigente([ia(true, 'No tenemos más de treinta mil euros', '2026-11-05T10:00:00Z')])).toBe(true);
  });
  it('la IA sin cita no vale, ni para marcarlo ni para levantarlo', () => {
    expect(noAptoVigente([ia(true, null, '2026-11-05T10:00:00Z')])).toBe(false);
    expect(noAptoVigente([ia(true, 'No tenemos más de treinta mil euros', '2026-11-05T10:00:00Z'), ia(false, null, '2026-11-08T10:00:00Z')])).toBe(true);
  });
  it('se levanta si una llamada posterior lo contradice con cita', () => {
    expect(noAptoVigente([
      ia(true, 'No tenemos más de treinta mil euros', '2026-11-05T10:00:00Z'),
      ia(false, 'Hemos conseguido financiación y ya llegamos al presupuesto', '2026-11-08T10:00:00Z'),
    ])).toBe(false);
  });
  it('el comercial lo puede quitar a mano, sin cita, y volver a ponerlo', () => {
    const marcado = ia(true, 'No tenemos más de treinta mil euros', '2026-11-05T10:00:00Z');
    expect(noAptoVigente([marcado, usuario(false, '2026-11-06T10:00:00Z')])).toBe(false);
    expect(noAptoVigente([marcado, usuario(false, '2026-11-06T10:00:00Z'), usuario(true, '2026-11-07T10:00:00Z')])).toBe(true);
  });
  it('un evento antiguo procesado tarde no pisa a uno más reciente', () => {
    const levanta = ia(false, 'Ya tenemos el presupuesto necesario para la reforma', '2026-11-08T10:00:00Z');
    const vieja = { ...ia(true, 'No tenemos más de treinta mil euros', '2026-11-01T10:00:00Z'), creadoEn: '2026-11-12T10:00:00Z' };
    expect(noAptoVigente([levanta, vieja])).toBe(false);
  });
});

describe('configuración de la agregación', () => {
  it('rechaza pesos que no son enteros o una matriz sin pesos', () => {
    const rota: CriterioConfig[] = MATRIZ_V1.map((c) => (c.criterioId === 'presupuesto' ? { ...c, peso: 12.5 } : c));
    expect(() => calcularCategoria({ niveles: niv(), noApto: false, presupuestoVigente: null, matriz: rota })).toThrow(/Peso no válido/);
    const vacia: CriterioConfig[] = MATRIZ_V1.map((c) => ({ ...c, peso: 0 }));
    expect(() => calcularCategoria({ niveles: niv(), noApto: false, presupuestoVigente: null, matriz: vacia })).toThrow(/no tiene pesos/);
  });
  it('los puntos, cortes y el umbral de A+ salen de la configuración', () => {
    const r = calcularCategoria({
      niveles: todosA(), noApto: false, presupuestoVigente: 60000,
      config: { ...AGREGACION_V1, umbralAPlus: 50000 },
    });
    expect(r.categoria).toBe('A+');
  });
});
