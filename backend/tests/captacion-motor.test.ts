import { describe, expect, it } from 'vitest';
import {
  calificar,
  categoriaFinal,
  crearEventoPresupuesto,
  cuentaComoPresupuesto,
  decidirWebhook,
  FORMULARIO_PRESUPUESTO,
  ordenarPorPotencial,
  planificarCargaInicial,
  ponderadoDe,
  presupuestoDelFormulario,
  presupuestoVigente,
  validarEscrituras,
  valorVigenteDe,
  type DatosEvento,
} from '../netelip/captacion/motor.ts';
import { ETIQUETA_SIN_PRESUPUESTO, type EventoPresupuesto } from '../netelip/captacion/tipos.ts';

let contador = 0;
const evento = (valor: number | [number, number], fechaInteraccion: string, extra: Partial<DatosEvento> = {}): EventoPresupuesto =>
  crearEventoPresupuesto({
    id: `ev-${++contador}`,
    fuente: 'llamada_netelip',
    tipo: Array.isArray(valor) ? 'rango' : 'exacto',
    valorMin: Array.isArray(valor) ? valor[0] : valor,
    valorMax: Array.isArray(valor) ? valor[1] : valor,
    fechaInteraccion,
    creadoEn: fechaInteraccion,
    registradoPor: 'ia',
    ...extra,
  });

const D10 = '2026-11-10T10:00:00Z';
const D12 = '2026-11-12T10:00:00Z';
const D13 = '2026-11-13T10:00:00Z';

describe('Presupuesto del formulario web · los 4 rangos del selector', () => {
  it('cada opción da su presupuesto: los cerrados el valor central, «menos de» la mitad y «más de» el piso', () => {
    expect(presupuestoDelFormulario('Menos de 40.000 €')).toEqual({ tipo: 'abierto_inferior', valorMin: null, valorMax: 40_000, valorVigente: 20_000 });
    expect(presupuestoDelFormulario('40.000 € - 100.000 €')).toEqual({ tipo: 'rango', valorMin: 40_000, valorMax: 100_000, valorVigente: 70_000 });
    expect(presupuestoDelFormulario('100.000 € - 200.000 €')).toEqual({ tipo: 'rango', valorMin: 100_000, valorMax: 200_000, valorVigente: 150_000 });
    expect(presupuestoDelFormulario('Más de 200.000 €')).toEqual({ tipo: 'abierto_superior', valorMin: 200_000, valorMax: null, valorVigente: 200_000 });
    expect(FORMULARIO_PRESUPUESTO).toEqual({ menosDe: 40_000, corteMedio: 100_000, masDe: 200_000 });
  });

  it('da igual el guion (– o -), el espacio duro, las mayúsculas, los puntos de millar o el símbolo €', () => {
    for (const texto of ['40.000 € – 100.000 €', '40.000 € - 100.000 €', '40000-100000', '  40.000\u00a0€ – 100.000\u00a0€  ', '40.000€-100.000€']) {
      expect(presupuestoDelFormulario(texto)?.valorVigente, texto).toBe(70_000);
    }
    for (const texto of ['MÁS DE 200.000 €', 'mas de 200000', 'Más de 200.000€']) expect(presupuestoDelFormulario(texto)?.valorVigente, texto).toBe(200_000);
    for (const texto of ['MENOS DE 40.000 €', 'menos de 40000']) expect(presupuestoDelFormulario(texto)?.valorVigente, texto).toBe(20_000);
  });

  it('lo que no es una de las 4 opciones NO inventa un presupuesto', () => {
    for (const raro of [null, undefined, '', '   ', 'Prefiero no decirlo', 'Menos de 50.000 €', 'Más de 300.000 €', '40.000 € - 90.000 €', '100.000 € - 300.000 €', 'De 40.000 a 100.000 y 200.000', '200.000 €']) {
      expect(presupuestoDelFormulario(raro as string | null | undefined), String(raro)).toBeNull();
    }
  });

  it('el presupuesto del formulario es del CLIENTE: lo manda la llamada posterior del cliente, pero no una cifra de LYN', () => {
    const formulario = evento([100_000, 200_000], '2026-11-01T10:00:00Z', { fuente: 'formulario', emisor: 'cliente', registradoPor: 'sistema', valorVigente: 150_000 });
    expect(presupuestoVigente([formulario])?.valorVigente).toBe(150_000);
    // Una llamada posterior en la que el cliente dice otro importe lo sustituye (RN-8).
    expect(presupuestoVigente([formulario, evento(60_000, D10, { emisor: 'cliente' })])?.valorVigente).toBe(60_000);
    // Una cifra que dice LYN, aunque sea posterior, NO pisa al del cliente.
    expect(presupuestoVigente([formulario, evento([60_000, 80_000], D12, { emisor: 'lyn' })])?.valorVigente).toBe(150_000);
    // Y un evento antiguo del cliente procesado tarde no pisa al del formulario si es anterior.
    expect(presupuestoVigente([formulario, evento(10_000, '2026-10-01T10:00:00Z', { emisor: 'cliente' })])?.valorVigente).toBe(150_000);
  });
});

describe('Escenario 1 · Valor central de un rango', () => {
  it('40.000 a 70.000 € da 55.000 €', () => {
    expect(valorVigenteDe({ tipo: 'rango', valorMin: 40_000, valorMax: 70_000 })).toBe(55_000);
    expect(evento([40_000, 70_000], D10).valorVigente).toBe(55_000);
  });
  it('un importe exacto es su propio valor', () => {
    expect(evento(120_000, D10).valorVigente).toBe(120_000);
  });
  it('un rango abierto no tiene regla (P-04) y pide el valor a mano', () => {
    expect(() => valorVigenteDe({ tipo: 'abierto_superior', valorMin: 100_000 })).toThrow(/P-04/);
    expect(
      crearEventoPresupuesto({
        id: 'x', fuente: 'formulario', tipo: 'abierto_superior', valorMin: 100_000, valorVigente: 100_000,
        fechaInteraccion: D10, creadoEn: D10, registradoPor: 'sistema',
      }).valorVigente,
    ).toBe(100_000);
  });
  it('un rango al revés o un importe 0 se rechazan', () => {
    expect(() => valorVigenteDe({ tipo: 'rango', valorMin: 70_000, valorMax: 40_000 })).toThrow();
    expect(() => evento(0, D10)).toThrow();
  });
});

describe('Escenario 2 · Manda el último por fecha de la interacción', () => {
  it('queda 25.000 € y los dos eventos siguen guardados', () => {
    const eventos = [evento([40_000, 70_000], D10), evento([20_000, 30_000], D12)];
    expect(presupuestoVigente(eventos)?.valorVigente).toBe(25_000);
    expect(eventos).toHaveLength(2);
  });
});

describe('Escenario 3 · Un evento antiguo procesado tarde no pisa al vigente', () => {
  it('la interacción del 10/11 procesada el 13/11 no cambia el vigente del 12/11', () => {
    const vigente = evento(50_000, D12);
    const tardio = evento(30_000, D10, { creadoEn: D13 });
    expect(presupuestoVigente([vigente, tardio])?.valorVigente).toBe(50_000);
    expect(presupuestoVigente([tardio, vigente])?.valorVigente).toBe(50_000);
  });
  it('si dos eventos son de la misma fecha, gana el registrado después', () => {
    const a = evento(30_000, D10, { creadoEn: '2026-11-10T11:00:00Z' });
    const b = evento(35_000, D10, { creadoEn: '2026-11-10T12:00:00Z' });
    expect(presupuestoVigente([a, b])?.valorVigente).toBe(35_000);
  });
});

describe('Escenario 3b · Una cifra que dice LYN no es el presupuesto del lead', () => {
  it('se guarda pero no cuenta: sin cifra del cliente, el presupuesto vigente es nulo', () => {
    const lyn = evento([60_000, 90_000], D12, { emisor: 'lyn' });
    expect(lyn.valorVigente).toBe(75_000);
    expect(presupuestoVigente([lyn])).toBeNull();
    expect(cuentaComoPresupuesto(lyn)).toBe(false);
  });
  it('una cifra posterior de LYN no pisa la del cliente', () => {
    const cliente = evento(55_000, D10, { emisor: 'cliente' });
    const lyn = evento(181_500, D12, { emisor: 'lyn' });
    expect(presupuestoVigente([cliente, lyn])?.valorVigente).toBe(55_000);
    expect(presupuestoVigente([lyn, cliente])?.valorVigente).toBe(55_000);
  });
  it('una cifra posterior del cliente sí manda sobre la anterior del cliente', () => {
    const vieja = evento(55_000, D10, { emisor: 'cliente' });
    const nueva = evento(90_000, D12, { emisor: 'cliente' });
    expect(presupuestoVigente([vieja, nueva])?.valorVigente).toBe(90_000);
  });
  it('sin emisor informado (N-1.1) cuenta, y la propuesta de la Fase 2 de LYN también cuenta', () => {
    expect(cuentaComoPresupuesto(evento(50_000, D10))).toBe(true);
    const fase2 = evento(120_000, D12, { emisor: 'lyn', fuente: 'fase2_lyn' });
    expect(cuentaComoPresupuesto(fase2)).toBe(true);
    expect(presupuestoVigente([fase2])?.valorVigente).toBe(120_000);
  });
  it('una cifra de LYN en reunión o WhatsApp tampoco cuenta', () => {
    expect(cuentaComoPresupuesto(evento(70_000, D10, { emisor: 'lyn', fuente: 'reunion_meet' }))).toBe(false);
    expect(cuentaComoPresupuesto(evento(70_000, D10, { emisor: 'lyn', fuente: 'whatsapp' }))).toBe(false);
  });
});

describe('Escenario 4 · Cálculo del ponderado', () => {
  it('B con 200.000 € da 150.000 €', () => {
    expect(ponderadoDe('B', 200_000)).toEqual({ factor: 0.75, ponderado: 150_000 });
  });
  it('B con rango 40-70 mil da 41.250 €', () => {
    expect(ponderadoDe('B', 55_000).ponderado).toBe(41_250);
  });
  it('A+ y A ponderan al 100 %, C al 45 %, D al 15 %', () => {
    expect(ponderadoDe('A+', 120_000).ponderado).toBe(120_000);
    expect(ponderadoDe('A', 80_000).ponderado).toBe(80_000);
    expect(ponderadoDe('C', 100_000).ponderado).toBe(45_000);
    expect(ponderadoDe('D', 100_000).ponderado).toBe(15_000);
  });
  it('redondea al euro sin errores de coma flotante (0,45 x 10 = 4,5 sube a 5)', () => {
    expect(ponderadoDe('C', 10).ponderado).toBe(5);
    expect(ponderadoDe('B', 99_999).ponderado).toBe(74_999);
  });
});

describe('Escenarios 5 y 6 · Regla A+', () => {
  it('100.000 € exactos con categoría A es A+', () => {
    expect(categoriaFinal({ categoriaElegida: 'A', presupuesto: 100_000 }).categoria).toBe('A+');
  });
  it('99.999 € con categoría A sigue siendo A', () => {
    expect(categoriaFinal({ categoriaElegida: 'A', presupuesto: 99_999 }).categoria).toBe('A');
  });
  it('B, C y D no se promocionan aunque el presupuesto sea alto', () => {
    expect(categoriaFinal({ categoriaElegida: 'B', presupuesto: 500_000 }).categoria).toBe('B');
  });
});

describe('Escenario 7 · A+ que pierde el requisito de importe', () => {
  it('baja a 80.000 € y pasa a A, con el cambio en el histórico', () => {
    const r = calificar({
      eventos: [evento(100_000, D10), evento(80_000, D12)],
      categoriaElegida: 'A+',
      previo: { categoria: 'A+', presupuestoVigente: 100_000 },
      disparador: 'presupuesto',
    });
    expect(r.categoria).toBe('A');
    expect(r.historial).toHaveLength(1);
    expect(r.historial[0]).toMatchObject({ categoria: 'A', motivo: 'cambio_presupuesto', presupuestoVigente: 80_000 });
  });
});

describe('Escenario 8 · A+ elegido a mano sin el importe', () => {
  it('queda en A y el histórico registra el intento y la corrección', () => {
    const r = calificar({
      eventos: [evento(60_000, D10)],
      categoriaElegida: 'A+',
      previo: { categoria: 'A', presupuestoVigente: 60_000 },
      disparador: 'categoria_manual',
    });
    expect(r.categoria).toBe('A');
    expect(r.historial.map((h) => [h.categoria, h.motivo])).toEqual([
      ['A+', 'cambio_categoria_manual'],
      ['A', 'cambio_categoria_manual'],
    ]);
  });
});

describe('Escenario 9 · No apto marcado por el comercial', () => {
  it('queda No apto, sin promoción a A+ y con ponderado 0', () => {
    const r = calificar({
      eventos: [evento(150_000, D10)],
      categoriaElegida: 'no_apto',
      previo: { categoria: 'A+', presupuestoVigente: 150_000 },
      disparador: 'categoria_manual',
    });
    expect(r.categoria).toBe('no_apto');
    expect(r.ponderado).toBe(0);
    expect(r.escrituras.ponderado).toBe(0);
  });
  it('un No apto sin presupuesto también pondera 0 (no queda vacío) y va al final de la vista', () => {
    const r = calificar({ eventos: [], categoriaElegida: 'no_apto', previo: null, disparador: 'alta' });
    expect(r.ponderado).toBe(0);
    expect(r.escrituras.ponderado).toBe(0);
    const orden = ordenarPorPotencial([
      { id: 'no', categoria: r.categoria, ponderado: r.ponderado },
      { id: 'd', categoria: 'D' as const, ponderado: 1_000 },
    ]);
    expect(orden.map((l) => l.id)).toEqual(['d', 'no']);
  });
});

describe('Escenario 10 · No continuidad por presupuesto insuficiente', () => {
  it('una B pasa a No apto y el histórico dice cambio_categoria_manual', () => {
    const r = calificar({
      eventos: [evento(50_000, D10)],
      categoriaElegida: 'B',
      noContinuidad: 'Presupuesto insuficiente',
      previo: { categoria: 'B', presupuestoVigente: 50_000 },
      disparador: 'categoria_manual',
    });
    expect(r.categoria).toBe('no_apto');
    expect(r.historial).toHaveLength(1);
    expect(r.historial[0]).toMatchObject({ categoria: 'no_apto', motivo: 'cambio_categoria_manual' });
  });
  it('otro motivo de no continuidad no la cambia', () => {
    expect(categoriaFinal({ categoriaElegida: 'B', presupuesto: 50_000, noContinuidad: 'Otro motivo' }).categoria).toBe('B');
  });
});

describe('Escenario 11 · Presupuesto a 0', () => {
  it('un importe 0 se trata como vacío', () => {
    const cero: EventoPresupuesto = { ...evento(1, D10), valorVigente: 0 };
    expect(presupuestoVigente([cero])).toBeNull();
  });
  it('un presupuesto_estimado = 0 en ClickUp deja al lead sin presupuesto y «Pendiente»', () => {
    const plan = planificarCargaInicial(
      [{ id: 't1', parentId: null, categoriaElegida: 'B', presupuestoClickUp: 0 }],
      new Set(),
      { fechaCarga: D13, idEvento: (id) => `ev-${id}` },
    );
    expect(plan.sinPresupuesto).toEqual(['t1']);
    expect(plan.altas[0]?.eventoNuevo).toBeNull();
    expect(plan.altas[0]?.calificacion.fuentePresupuesto).toBe(ETIQUETA_SIN_PRESUPUESTO);
  });
});

describe('Escenario 12 · Lead sin presupuesto', () => {
  it('Presupuesto y Ponderado quedan vacíos y la fuente dice «Pendiente»', () => {
    const r = calificar({ eventos: [], categoriaElegida: 'B', previo: null, disparador: 'alta' });
    expect(r.presupuestoVigente).toBeNull();
    expect(r.ponderado).toBeNull();
    expect(r.fuentePresupuesto).toBe(ETIQUETA_SIN_PRESUPUESTO);
    expect(r.escrituras).toEqual({ categoria: 'B', presupuesto: null, ponderado: null, fuente_presupuesto: ETIQUETA_SIN_PRESUPUESTO });
  });
  it('aparece al final de su categoría', () => {
    const orden = ordenarPorPotencial([
      { id: 'sin', categoria: 'B' as const, ponderado: null },
      { id: 'alto', categoria: 'B' as const, ponderado: 90_000 },
      { id: 'bajo', categoria: 'B' as const, ponderado: 10_000 },
    ]);
    expect(orden.map((l) => l.id)).toEqual(['alto', 'bajo', 'sin']);
  });
});

describe('Escenario 13 · Cambio manual del presupuesto', () => {
  it('registra un evento «manual» con su usuario y recalcula el ponderado', () => {
    const previo = evento([40_000, 70_000], D10, { fuente: 'formulario' });
    const manual = evento(90_000, D12, { fuente: 'manual', registradoPor: 'usuario', usuarioId: 'u-comercial' });
    const r = calificar({
      eventos: [previo, manual],
      categoriaElegida: 'B',
      previo: { categoria: 'B', presupuestoVigente: 55_000 },
      disparador: 'presupuesto',
    });
    expect(manual).toMatchObject({ fuente: 'manual', usuarioId: 'u-comercial', registradoPor: 'usuario' });
    expect(r.presupuestoVigente).toBe(90_000);
    expect(r.ponderado).toBe(67_500);
    expect(r.fuentePresupuesto).toBe('Manual');
    expect(r.historial[0]).toMatchObject({ motivo: 'cambio_presupuesto', presupuestoVigente: 90_000 });
  });
  it('un evento antiguo que no cambia el vigente no agrega fila al histórico', () => {
    const vigente = evento(50_000, D12);
    const tardio = evento(30_000, D10, { creadoEn: D13 });
    const r = calificar({
      eventos: [vigente, tardio],
      categoriaElegida: 'B',
      previo: { categoria: 'B', presupuestoVigente: 50_000 },
      disparador: 'presupuesto',
    });
    expect(r.historial).toEqual([]);
  });
});

describe('Escenario 14 · Las subtareas no se procesan', () => {
  it('un webhook de una subtarea se descarta', () => {
    expect(decidirWebhook({ parentId: 'madre', usuarioId: 'u-comercial' }, 'u-integracion')).toEqual({
      procesar: false,
      motivo: 'subtarea',
    });
  });
  it('la carga inicial no crea calificación ni evento para una subtarea', () => {
    const plan = planificarCargaInicial(
      [{ id: 'sub', parentId: 'madre', categoriaElegida: 'A', presupuestoClickUp: 80_000 }],
      new Set(),
      { fechaCarga: D13, idEvento: (id) => `ev-${id}` },
    );
    expect(plan.altas).toEqual([]);
    expect(plan.omitidas).toEqual([{ id: 'sub', motivo: 'subtarea' }]);
  });
});

describe('Escenario 15 · Las escrituras del sistema no generan un bucle', () => {
  it('el webhook que provoca el propio usuario de integración se descarta', () => {
    expect(decidirWebhook({ parentId: null, usuarioId: 'u-integracion' }, 'u-integracion')).toEqual({
      procesar: false,
      motivo: 'escritura_del_sistema',
    });
  });
  it('el cambio de un comercial sí se procesa', () => {
    expect(decidirWebhook({ parentId: null, usuarioId: 'u-comercial' }, 'u-integracion')).toEqual({ procesar: true });
  });
});

describe('Escenario 16 · El sistema no toca los campos operativos', () => {
  it('cualquier recálculo escribe solo categoría, presupuesto, ponderado y fuente', () => {
    const r = calificar({ eventos: [evento(120_000, D10)], categoriaElegida: 'A', previo: null, disparador: 'alta' });
    expect(Object.keys(validarEscrituras(r.escrituras)).sort()).toEqual(['categoria', 'fuente_presupuesto', 'ponderado', 'presupuesto']);
  });
  it('rechaza escribir ETAPA_CRM, estado, fecha de inicio o título', () => {
    for (const campo of ['etapa_crm', 'status', 'start_date', 'name']) {
      expect(() => validarEscrituras({ categoria: 'A', [campo]: 'x' })).toThrow(/Campos no permitidos/);
    }
  });
  it('el índice de orden está permitido (solo se crea si la vista no ordena por dos campos)', () => {
    expect(() => validarEscrituras({ indice_orden: 12 })).not.toThrow();
  });
});

describe('Escenario 17 · La integración con GHL no se altera', () => {
  it.todo('requiere el lead de prueba en ClickUp y acceso a GHL: no se puede probar sin la lista');
});

describe('Escenario 18 · Vista ordenada sin tocar el tablero de Ernesto', () => {
  it('ordena A+, A, B, C, D, Sin calificar, No apto y, dentro de cada una, por ponderado descendente', () => {
    const leads = [
      { id: 'no', categoria: 'no_apto' as const, ponderado: 0 },
      { id: 'd', categoria: 'D' as const, ponderado: 5_000 },
      { id: 'a2', categoria: 'A' as const, ponderado: 70_000 },
      { id: 'sc', categoria: 'sin_calificar' as const, ponderado: null },
      { id: 'ap', categoria: 'A+' as const, ponderado: 120_000 },
      { id: 'a1', categoria: 'A' as const, ponderado: 90_000 },
      { id: 'c', categoria: 'C' as const, ponderado: 20_000 },
      { id: 'b', categoria: 'B' as const, ponderado: 40_000 },
    ];
    expect(ordenarPorPotencial(leads).map((l) => l.id)).toEqual(['ap', 'a1', 'a2', 'b', 'c', 'd', 'sc', 'no']);
  });
  it('no modifica la lista que recibe', () => {
    const leads = [
      { id: 'b', categoria: 'B' as const, ponderado: 1 },
      { id: 'a', categoria: 'A' as const, ponderado: 1 },
    ];
    ordenarPorPotencial(leads);
    expect(leads.map((l) => l.id)).toEqual(['b', 'a']);
  });
  it.todo('la vista «Board · Por potencial» en ClickUp (agrupada por ETAPA_CRM, sin tocar el Board actual) requiere acceso a la lista');
});

describe('Escenario 19 · Carga inicial', () => {
  const tareas = [
    { id: 't1', parentId: null, categoriaElegida: 'B' as const, presupuestoClickUp: 200_000 },
    { id: 't2', parentId: null, categoriaElegida: 'A' as const, presupuestoClickUp: null },
    { id: 'sub', parentId: 't1', categoriaElegida: 'A' as const, presupuestoClickUp: 50_000 },
    { id: 't4', parentId: null, categoriaElegida: null, presupuestoClickUp: 0 },
  ];
  const opciones = { fechaCarga: D13, idEvento: (id: string) => `ev-${id}` };

  it('cada lead con presupuesto queda con presupuesto, ponderado y un registro «alta»', () => {
    const plan = planificarCargaInicial(tareas, new Set(), opciones);
    const t1 = plan.altas.find((a) => a.clickupTaskId === 't1');
    expect(t1?.calificacion).toMatchObject({ categoria: 'B', presupuestoVigente: 200_000, ponderado: 150_000 });
    expect(t1?.calificacion.historial.map((h) => h.motivo)).toEqual(['alta']);
    expect(t1?.eventoNuevo).toMatchObject({ fuente: 'manual', interaccionId: 'carga-inicial:t1', registradoPor: 'sistema' });
  });
  it('entrega el listado de los leads sin presupuesto y deja fuera las subtareas', () => {
    const plan = planificarCargaInicial(tareas, new Set(), opciones);
    expect(plan.sinPresupuesto).toEqual(['t2', 't4']);
    expect(plan.altas.map((a) => a.clickupTaskId)).toEqual(['t1', 't2', 't4']);
    expect(plan.omitidas).toEqual([{ id: 'sub', motivo: 'subtarea' }]);
  });
  it('correrla dos veces no duplica registros', () => {
    const primera = planificarCargaInicial(tareas, new Set(), opciones);
    const cargadas = new Set(primera.altas.map((a) => a.clickupTaskId));
    const segunda = planificarCargaInicial(tareas, cargadas, opciones);
    expect(segunda.altas).toEqual([]);
    expect(segunda.omitidas.filter((o) => o.motivo === 'ya_cargada').map((o) => o.id)).toEqual(['t1', 't2', 't4']);
  });
});
