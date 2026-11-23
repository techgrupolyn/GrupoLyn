// N-1.4 · Calibración con el histórico: desenlace del lead, comparación con la decisión de la IA, informe, ejecutable y recorrido completo
// (lote con llamadas antiguas + ClickUp falso + modelo falso). Sin red y sin escribir nada en ClickUp.
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { armarInforme, contrastar, desenlaceDeLead, ejecutarCalibracion, type DecisionHistorica } from '../netelip/captacion/calibracion.ts';
import { informeCsvCalibracion, leerArgumentosCalibracion, resumenCalibracion } from '../netelip/captacion/calibracion-cli.ts';
import { ClickUpClient } from '../netelip/captacion/clickup.ts';
import type { Decision } from '../netelip/captacion/decision.ts';
import { acierto, bandeja } from '../netelip/captacion/decision-repositorio.ts';
import type { Db } from '../netelip/captacion/repositorio.ts';
import { ensureNetelipCalls } from '../netelip/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { CITA_FECHA, FRASE, salidaModelo, TRANSCRIPCION_CON_FECHA } from './helpers/captacion-llamadas.ts';
import { levantarClickUpFalso, LISTA_FALSA, TOKEN_FALSO, type ClickUpFalso, type TareaFalsa } from './helpers/clickup-falso.ts';

describe('desenlace del lead según su fase', () => {
  it.each([
    ['e1. EN ESPERA', 'antes_de_f2'], ['e3. VIABILIDAD', 'antes_de_f2'], ['E2. algo', 'antes_de_f2'],
    ['e4. VISITA', 'avanzo'], ['e9. 1a PRESENTACIÓN', 'avanzo'], ['e13. CONFIRMACIÓN RESULTADO', 'avanzo'], ['e14. GANADO', 'avanzo'], ['e18. PASE', 'avanzo'],
    ['e15. PERDIDO', 'perdido'], ['e16. RECHAZADO', 'perdido'],
    ['e17. OTRA', 'sin_etapa'], ['e19. OTRA', 'sin_etapa'], ['e0. NADA', 'sin_etapa'], ['RECHAZADO', 'sin_etapa'], ['', 'sin_etapa'], [null, 'sin_etapa'],
  ] as const)('«%s» → %s', (etapa, esperado) => {
    expect(desenlaceDeLead(etapa)).toBe(esperado);
  });
});

describe('una tarjeta cerrada por «Error» no es un resultado de negocio', () => {
  it.each([
    ['e16. RECHAZADO', 'Error', 'sin_etapa'], ['e15. PERDIDO', ' error ', 'sin_etapa'], ['e16. RECHAZADO', 'Presupuesto insuficiente', 'perdido'],
    ['e16. RECHAZADO', null, 'perdido'], ['e4. VISITA', 'Error', 'avanzo'], ['e3. VIABILIDAD', 'Error', 'antes_de_f2'],
  ] as const)('«%s» con No continuidad «%s» → %s', (etapa, noContinuidad, esperado) => {
    expect(desenlaceDeLead(etapa, noContinuidad)).toBe(esperado);
  });

  it('en el informe, la decisión sobre una tarjeta duplicada (Error) queda sin referencia en vez de «difiere»', () => {
    const fila = { llamadaId: '1', ocurridaEn: '2026-11-11T10:17:29.000Z', estado: 'procesada', categoria: 'A', lead: { id: 'a', nombre: 'Lead', etapa: 'e16. RECHAZADO', noContinuidad: 'Error' } };
    const i = armarInforme([fila], [{ llamadaId: 'netelip:1', decision: 'pasar_a_reunion', motivo: 'decisores_disponibles', excepciones: [], dudas: [], pendienteErnesto: false }]);
    expect(i.filas[0]).toMatchObject({ desenlace: 'sin_etapa', contraste: 'sin_referencia' });
    expect(i.resumen.coincidenciaPorcentaje).toBeNull();
  });
});

describe('contrastar la decisión de la IA con el desenlace', () => {
  const tabla: Array<[Decision, ...Array<'coincide' | 'difiere' | 'sin_referencia'>]> = [
    // avanzo, perdido, antes_de_f2, sin_etapa
    ['pasar_a_reunion', 'coincide', 'difiere', 'difiere', 'sin_referencia'],
    ['descartar', 'difiere', 'coincide', 'difiere', 'sin_referencia'],
    ['seguimiento', 'sin_referencia', 'sin_referencia', 'coincide', 'sin_referencia'],
    ['derivar_partners', 'sin_referencia', 'sin_referencia', 'sin_referencia', 'sin_referencia'],
  ];
  for (const [decision, ...esperados] of tabla) {
    it(`${decision}`, () => {
      expect((['avanzo', 'perdido', 'antes_de_f2', 'sin_etapa'] as const).map((d) => contrastar(decision, d))).toEqual(esperados);
    });
  }
});

describe('armarInforme', () => {
  const lead = (id: string, etapa: string | null, noContinuidad: string | null = null) => ({ id, nombre: `Lead ${id}`, etapa, noContinuidad });
  const fila = (llamadaId: string, estado: string, l: ReturnType<typeof lead> | null, categoria: string | null = 'A') => ({ llamadaId, ocurridaEn: '2026-10-01T10:00:00.000Z', estado, categoria, lead: l });
  const dec = (n: string, decision: Decision, o: Partial<DecisionHistorica> = {}): DecisionHistorica => ({ llamadaId: `netelip:${n}`, decision, motivo: 'presupuesto_suficiente', excepciones: [], dudas: [], pendienteErnesto: false, ...o });

  it('Escenario «Calibración con todo el histórico transcrito»: las que tienen lead identificado entran; las que no, quedan fuera y solo se cuentan', () => {
    const i = armarInforme(
      [fila('1', 'procesada', lead('a', 'e4. VISITA')), fila('2', 'sin_lead', null, null), fila('3', 'procesada', lead('b', 'e15. PERDIDO', 'Presupuesto insuficiente')), fila('4', 'sin_conversacion', null, null), fila('5', 'error', null, null), fila('6', 'modelo_fallo', lead('c', null), null), fila('7', 'salida_invalida', null, null)],
      [dec('1', 'pasar_a_reunion'), dec('3', 'descartar', { motivo: 'presupuesto_insuficiente' })],
    );
    expect(i.filas.map((f) => f.leadId)).toEqual(['a', 'b']);
    expect(i.resumen).toMatchObject({ llamadas: 7, analizadas: 2, sinLead: 2, errores: 3, conDecision: 2, sinDecision: 0, porDecision: { pasar_a_reunion: 1, descartar: 1 }, porContraste: { coincide: 2 }, coincidenciaPorcentaje: 100 });
    expect(i.filas[1]).toMatchObject({ lead: 'Lead b', etapa: 'e15. PERDIDO', desenlace: 'perdido', noContinuidad: 'Presupuesto insuficiente', decisionIA: 'descartar', motivo: 'presupuesto_insuficiente', contraste: 'coincide', fecha: '2026-10-01T10:00:00.000Z' });
  });

  it('una llamada procesada sin decisión de la IA entra en el informe sin decisión y sin contraste', () => {
    const i = armarInforme([fila('1', 'procesada', lead('a', 'e3. VIABILIDAD'))], []);
    expect(i.filas[0]).toMatchObject({ decisionIA: null, motivo: null, contraste: null, excepciones: [], dudas: [], pendienteErnesto: false });
    expect(i.resumen).toMatchObject({ analizadas: 1, conDecision: 0, sinDecision: 1, porDecision: {}, porContraste: {}, coincidenciaPorcentaje: null });
  });

  it('el informe dice por qué una llamada procesada no tiene decisión y por qué otras quedaron sin lead', () => {
    const f = (id: string, estado: string, l: ReturnType<typeof lead> | null, extra: { motivo?: string | null; decisionEstado?: string | null } = {}) => ({ ...fila(id, estado, l), ...extra });
    const i = armarInforme(
      [
        f('1', 'procesada', lead('a', 'e3. VIABILIDAD'), { decisionEstado: 'guardada' }),
        f('2', 'procesada', lead('b', 'e3. VIABILIDAD'), { decisionEstado: 'sin_decision' }),
        f('3', 'procesada', lead('c', 'e3. VIABILIDAD'), { decisionEstado: 'invalida: la cita no está en la llamada' }),
        f('4', 'procesada', lead('d', 'e3. VIABILIDAD')),
        f('5', 'sin_lead', null, { motivo: 'sin_coincidencia' }),
        f('6', 'sin_lead', null, { motivo: 'sin_coincidencia' }),
        f('7', 'sin_lead', null, { motivo: 'telefono_ambiguo' }),
        f('8', 'sin_conversacion', null),
      ],
      [dec('1', 'seguimiento')],
    );
    expect(i.filas.map((x) => [x.leadId, x.sinDecisionPor])).toEqual([
      ['a', null], ['b', 'sin_decision'], ['c', 'invalida: la cita no está en la llamada'], ['d', 'desconocido'],
    ]);
    expect(i.resumen.sinDecisionPorMotivo).toEqual({ sin_decision: 1, 'invalida: la cita no está en la llamada': 1, desconocido: 1 });
    expect(i.resumen.sinLeadPorMotivo).toEqual({ sin_coincidencia: 2, telefono_ambiguo: 1, sin_conversacion: 1 });
  });

  it('el porcentaje de coincidencia solo cuenta los casos con referencia (no los «sin referencia») y se redondea', () => {
    const i = armarInforme(
      [fila('1', 'procesada', lead('a', 'e4. VISITA')), fila('2', 'procesada', lead('b', 'e3. VIABILIDAD')), fila('3', 'procesada', lead('c', 'e16. RECHAZADO')), fila('4', 'procesada', lead('d', 'e4. VISITA'))],
      [dec('1', 'pasar_a_reunion'), dec('2', 'pasar_a_reunion'), dec('3', 'pasar_a_reunion'), dec('4', 'derivar_partners')],
    );
    expect(i.resumen.porContraste).toEqual({ coincide: 1, difiere: 2, sin_referencia: 1 });
    expect(i.resumen.coincidenciaPorcentaje).toBe(33);
  });

  it('dos coincidencias de tres casos con referencia dan 67 %, no 66 (se redondea, no se trunca)', () => {
    const i = armarInforme(
      [fila('1', 'procesada', lead('a', 'e4. VISITA')), fila('2', 'procesada', lead('b', 'e9. 1a PRESENTACIÓN')), fila('3', 'procesada', lead('c', 'e3. VIABILIDAD'))],
      [dec('1', 'pasar_a_reunion'), dec('2', 'pasar_a_reunion'), dec('3', 'pasar_a_reunion')],
    );
    expect(i.resumen.porContraste).toEqual({ coincide: 2, difiere: 1 });
    expect(i.resumen.coincidenciaPorcentaje).toBe(67);
  });

  it('lleva las excepciones, las dudas y el «pendiente de Ernesto» de la decisión', () => {
    const i = armarInforme([fila('1', 'procesada', lead('a', 'e3. VIABILIDAD'))], [dec('1', 'seguimiento', { excepciones: ['descuento', 'topografo'], dudas: ['encaje_incierto'], pendienteErnesto: true })]);
    expect(i.filas[0]).toMatchObject({ excepciones: ['descuento', 'topografo'], dudas: ['encaje_incierto'], pendienteErnesto: true });
  });
});

describe('ejecutable de la calibración', () => {
  const ahora = new Date('2026-11-18T15:00:00Z');
  it('por defecto toma todo el histórico (desde 2020-01-01 hasta mañana, en UTC); acepta ventana y límite', () => {
    const a = leerArgumentosCalibracion(['--informe', 'c.csv'], ahora);
    expect(a.desde.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(a.hasta.toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(a).toMatchObject({ informe: 'c.csv', limite: undefined, confirmoCopia: false });
    const b = leerArgumentosCalibracion(['--informe', 'c.csv', '--desde', '2026-09-01', '--hasta', '2026-11-01', '--limite', '20', '--confirmo-copia'], ahora);
    expect(b.desde.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(b).toMatchObject({ limite: 20, confirmoCopia: true });
  });
  it.each([
    ['sin informe', [], 'Falta --informe'],
    ['argumento suelto', ['--informe', 'x', 'y'], 'Argumento inesperado: y'],
    ['argumento desconocido', ['--informe', 'x', '--candidatos', 'todos'], 'Argumento desconocido'],
    ['opción sin valor', ['--informe', 'x', '--desde'], 'Falta el valor de --desde'],
    ['fecha mal escrita', ['--informe', 'x', '--desde', '1/9/2026'], '--desde debe ser una fecha AAAA-MM-DD'],
    ['fecha imposible', ['--informe', 'x', '--desde', '2026-02-30'], 'no es una fecha válida'],
    ['ventana al revés', ['--informe', 'x', '--desde', '2026-11-01', '--hasta', '2026-10-01'], '--hasta debe ser posterior'],
    ['límite decimal', ['--informe', 'x', '--limite', '1.5'], '--limite debe ser un número entero'],
    ['límite enorme', ['--informe', 'x', '--limite', '99999999999999999999'], '--limite debe ser un número entero'],
  ])('rechaza: %s', (_n, argv, mensaje) => {
    expect(() => leerArgumentosCalibracion(argv as string[], ahora)).toThrow(mensaje);
  });

  const informe = armarInforme(
    [{ llamadaId: '1', ocurridaEn: '2026-10-01T10:00:00.000Z', estado: 'procesada', categoria: 'A+', lead: { id: 'a', nombre: '=HYPERLINK("x")', etapa: 'e4. VISITA', noContinuidad: null } }],
    [{ llamadaId: 'netelip:1', decision: 'pasar_a_reunion', motivo: 'presupuesto_suficiente', excepciones: ['descuento'], dudas: ['encaje_incierto', 'presupuesto_limite'], pendienteErnesto: true }],
  );
  it('el CSV es para Excel: BOM, «;», cabecera y una fila por llamada analizada, con las celdas peligrosas neutralizadas', () => {
    const csv = informeCsvCalibracion(informe);
    expect(csv.startsWith('﻿fecha;llamada;lead;lead_id;etapa_actual;categoria;decision_ia;motivo;excepciones;dudas;pendiente_de_ernesto;desenlace;no_continuidad;contraste;sin_decision_por\r\n')).toBe(true);
    const lineas = csv.split('\r\n');
    expect(lineas).toHaveLength(3);
    expect(lineas[1]).toBe('2026-10-01T10:00:00.000Z;1;"\'=HYPERLINK(""x"")";a;e4. VISITA;A+;pasar_a_reunion;presupuesto_suficiente;descuento;encaje_incierto | presupuesto_limite;sí;avanzo;;coincide;');
  });
  it('el resumen de pantalla lleva solo totales: ni nombres ni citas', () => {
    const t = resumenCalibracion(informe);
    expect(t).toBe([
      'Llamadas con transcripción: 1 · analizadas (con lead identificado): 1 · sin lead identificado (fuera del informe): 0 · con error: 0',
      'Decisión de la IA: 1 con decisión · 0 sin ella → pasar_a_reunion 1',
      'Frente al desenlace del lead: coincide 1 · coincide el 100 % de los que tienen referencia',
    ].join('\n'));
    expect(t).not.toContain('HYPERLINK');
    expect(resumenCalibracion(armarInforme([], []))).toContain('Frente al desenlace del lead: —');
    // Sin llamadas sin lead ni sin decisión, las líneas de motivos no salen.
    expect(resumenCalibracion(armarInforme([], []))).not.toContain('por motivo');
  });

  it('los fallos del modelo o de la salida se cuentan por tipo y motivo, para saber qué pasó con la llamada que quedó fuera del informe', () => {
    const base = { ocurridaEn: '2026-10-01T10:00:00.000Z', categoria: null, lead: null };
    const i = armarInforme(
      [
        { ...base, llamadaId: '1', estado: 'modelo_fallo', motivo: 'Gemini 503: el modelo está sobrecargado' },
        { ...base, llamadaId: '2', estado: 'modelo_fallo', motivo: 'Gemini 503: el modelo está sobrecargado' },
        { ...base, llamadaId: '3', estado: 'salida_invalida', motivo: `la salida no es JSON ${'x'.repeat(200)}` },
        { ...base, llamadaId: '4', estado: 'error', motivo: null },
        { ...base, llamadaId: '5', estado: 'procesada', lead: { id: 'a', nombre: 'Ana', etapa: 'e3. VIABILIDAD' } },
      ],
      [],
    );
    expect(i.resumen.errores).toBe(4);
    expect(i.resumen.erroresPorMotivo).toEqual({
      'modelo_fallo: Gemini 503: el modelo está sobrecargado': 2,
      [`salida_invalida: la salida no es JSON ${'x'.repeat(80 - 'la salida no es JSON '.length)}`]: 1,
      'error: sin detalle': 1,
    });
    expect(resumenCalibracion(i)).toContain('Errores por motivo: modelo_fallo: Gemini 503: el modelo está sobrecargado 2');
    expect(resumenCalibracion(armarInforme([], []))).not.toContain('Errores por motivo');
  });

  it('el resumen de pantalla y el CSV dicen los motivos de las llamadas sin lead y sin decisión, sin nombres', () => {
    const i = armarInforme(
      [
        { llamadaId: '1', ocurridaEn: '2026-10-01T10:00:00.000Z', estado: 'procesada', categoria: 'B', lead: { id: 'a', nombre: 'Ana Secreta', etapa: 'e3. VIABILIDAD' }, decisionEstado: 'sin_decision' },
        { llamadaId: '2', ocurridaEn: '2026-10-01T11:00:00.000Z', estado: 'sin_lead', categoria: null, lead: null, motivo: 'sin_coincidencia' },
      ],
      [],
    );
    const t = resumenCalibracion(i);
    expect(t).toContain('Sin lead por motivo: sin_coincidencia 1');
    expect(t).toContain('Sin decisión por motivo: sin_decision 1');
    expect(t).not.toContain('Ana Secreta');
    expect(informeCsvCalibracion(i).split('\r\n')[1]!.endsWith(';sin_decision')).toBe(true);
  });
});

const DESDE = new Date('2020-01-01T00:00:00Z');
const HASTA = new Date('2026-11-19T00:00:00Z');
const ETAPA = { en_espera: 0, viabilidad: 1, visita: 2, rechazado: 3, perdido: 4 };

describe.skipIf(!hayBaseDePruebas)('calibración con el histórico, de punta a punta', () => {
  let base: BaseAislada;
  let pool: Pool;
  let falso: ClickUpFalso;
  let cliente: ClickUpClient;
  const decisiones = new Map<string, unknown>();

  /** Cuántas veces se le ha pedido cada llamada al modelo, y las llamadas a las que la primera vez les «olvida» la decisión. */
  const vistas = new Map<string, number>();
  const olvidaLaPrimera = new Set<string>();
  const evaluar = async (_s: string, usuario: string): Promise<RespuestaModelo> => {
    const id = /interaccion_id (\S+)/.exec(usuario)![1]!;
    const n = id.split(':')[1]!;
    const vez = (vistas.get(n) ?? 0) + 1;
    vistas.set(n, vez);
    const decisionIA = olvidaLaPrimera.has(n) && vez === 1 ? undefined : decisiones.get(n);
    return { text: salidaModelo(id, { decisionIA }), model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
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
    falso = await levantarClickUpFalso();
    cliente = new ClickUpClient({ token: TOKEN_FALSO, listaId: LISTA_FALSA, baseUrl: falso.base, pausaMs: 0, esperar: async () => undefined });
    decisiones.clear();
    vistas.clear();
    olvidaLaPrimera.clear();
  });
  afterEach(async () => {
    await falso.cerrar();
    await base.cerrar();
  });

  const llamada = async (id: string, telefono: string | null, ocurrida = '2026-09-10T10:00:00Z'): Promise<string> => {
    const r = await base.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, duration_seconds, call_status, received_at)
       VALUES ($1, 'outbound', $2, 'uniqueid', $3, $4, 'unknown', 240, 'ANSWERED', now()) RETURNING id`,
      [id, ocurrida, telefono ?? 'anonymous', telefono],
    );
    const callId = String(r.rows[0]!.id);
    await base.query('INSERT INTO netelip_call_transcriptions (call_id, status, text, segments) VALUES ($1, $2, $3, $4)', [callId, 'completed', TRANSCRIPCION_CON_FECHA, null]);
    return callId;
  };
  const decision = (d: string, motivo = 'presupuesto_suficiente') => ({
    decision: d, motivos: [{ codigo: motivo, cita: FRASE.decisor, texto: null }], excepciones: [], dudas: [], pendiente_ernesto: null,
    proximos_pasos: [{ orden: 1, accion: 'Llamar', cuando: { tipo: 'plazo_guion', valor: 'en una semana' }, canal: 'llamada', que_pedir: null, requiere_ernesto: false, cita: CITA_FECHA }],
  });
  const tareas = (...t: TareaFalsa[]) => { falso.tareas = t; };
  const calibrar = () => ejecutarCalibracion({ pool, cliente, evaluar, desde: DESDE, hasta: HASTA, esperar: async () => undefined });
  const posts = () => falso.peticiones.filter((p) => p.metodo !== 'GET');

  it('analiza todas las llamadas con lead identificado (también de leads ya en F2 o perdidos), deja fuera las que no lo tienen y no escribe nada en ClickUp', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.visita },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.perdido },
      { id: 'caro', nombre: 'Caro', telefono: '+34600000003', etapa: ETAPA.viabilidad },
    );
    decisiones.set(await llamada('u1', '+34600000001'), decision('pasar_a_reunion'));
    decisiones.set(await llamada('u2', '+34600000002'), decision('descartar', 'cliente_no_sigue'));
    decisiones.set(await llamada('u3', '+34600000003'), decision('seguimiento', 'quiere_pensarlo'));
    await llamada('u4', '+34699999999');
    await llamada('u5', null);

    const i = await calibrar();
    expect(i.filas.map((f) => [f.lead, f.decisionIA, f.desenlace, f.contraste])).toEqual([
      ['Ana', 'pasar_a_reunion', 'avanzo', 'coincide'], ['Beto', 'descartar', 'perdido', 'coincide'], ['Caro', 'seguimiento', 'antes_de_f2', 'coincide'],
    ]);
    expect(i.resumen).toMatchObject({ llamadas: 5, analizadas: 3, sinLead: 2, errores: 0, conDecision: 3, coincidenciaPorcentaje: 100 });
    expect(posts()).toEqual([]);
  });

  it('el informe explica por qué una llamada no tiene decisión (el modelo no la dio, o dio una que no existe) y por qué otras no tienen lead', async () => {
    tareas(
      { id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.viabilidad },
      { id: 'caro', nombre: 'Caro', telefono: '+34600000003', etapa: ETAPA.viabilidad },
    );
    await llamada('u1', '+34600000001');
    decisiones.set(await llamada('u2', '+34600000002'), { ...decision('descartar', 'cliente_no_sigue'), decision: 'dejarlo_en_el_aire' });
    decisiones.set(await llamada('u3', '+34600000003'), decision('seguimiento', 'quiere_pensarlo'));
    await llamada('u4', '+34699999999');
    await llamada('u5', null);

    const i = await calibrar();
    expect(i.filas.map((f) => [f.lead, f.decisionIA, f.sinDecisionPor])).toEqual([
      ['Ana', null, 'sin_decision'], ['Beto', null, 'invalida: la decisión de la IA no es una de las cuatro posibles'], ['Caro', 'seguimiento', null],
    ]);
    expect(i.resumen.sinDecisionPorMotivo).toMatchObject({ sin_decision: 1 });
    expect(Object.values(i.resumen.sinLeadPorMotivo).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.keys(i.resumen.sinLeadPorMotivo)).not.toContain('desconocido');
  });

  it('si el modelo «olvida» la decisión de una llamada, la calibración se la vuelve a pedir una vez y la decisión entra en el informe', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad }, { id: 'beto', nombre: 'Beto', telefono: '+34600000002', etapa: ETAPA.viabilidad });
    const a = await llamada('u1', '+34600000001');
    const b = await llamada('u2', '+34600000002');
    decisiones.set(a, decision('seguimiento', 'quiere_pensarlo'));
    decisiones.set(b, decision('seguimiento', 'quiere_pensarlo'));
    olvidaLaPrimera.add(a);
    const i = await calibrar();
    expect(i.filas.map((f) => [f.lead, f.decisionIA, f.sinDecisionPor])).toEqual([['Ana', 'seguimiento', null], ['Beto', 'seguimiento', null]]);
    expect(vistas.get(a)).toBe(2);
    expect(vistas.get(b)).toBe(1);
    expect(i.resumen.sinDecision).toBe(0);
  });

  it('Escenario «El histórico no cuenta para el acierto»: las decisiones quedan como históricas, sin caso en la bandeja ni casos revisados', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.visita });
    for (let n = 1; n <= 5; n++) decisiones.set(await llamada(`u${n}`, '+34600000001', `2026-09-0${n}T10:00:00Z`), decision('pasar_a_reunion'));
    await calibrar();
    const filas = (await base.query("SELECT origen, actor FROM decision_lead")).rows;
    expect(filas).toHaveLength(5);
    expect(filas.every((f) => f.origen === 'historico' && f.actor === 'ia')).toBe(true);
    expect(await bandeja(base as unknown as Db, { estado: 'todos' })).toEqual([]);
    expect((await acierto(base as unknown as Db)).every((f) => f.revisados === 0 && f.porcentaje === null)).toBe(true);
  });

  it('una llamada cuyo modelo no devuelve decisión entra en el informe sin decisión', async () => {
    tareas({ id: 'ana', nombre: 'Ana', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada('u1', '+34600000001');
    const i = await calibrar();
    expect(i.filas[0]).toMatchObject({ lead: 'Ana', decisionIA: null, contraste: null });
    expect(i.resumen).toMatchObject({ analizadas: 1, sinDecision: 1 });
  });
});
