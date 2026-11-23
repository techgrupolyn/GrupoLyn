// Carga inicial de la captación ABCD de punta a punta: tablas reales de la captación (esquema aislado) + un ClickUp en
// memoria (las escrituras cambian la tarjeta, así que se puede repetir la carga y ver que ya no hay nada que hacer).
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClickUpError, indiceOrdenDe, NOMBRES_CAMPOS, type CampoLista, type TareaClickUp } from '../netelip/captacion/clickup.ts';
import { ejecutarCargaInicial, type InformeCarga } from '../netelip/captacion/carga-inicial.ts';
import { informeCsvCarga, leerArgumentosCarga, mainCarga, resumenCarga } from '../netelip/captacion/carga-inicial-cli.ts';
import { ensureCaptacion } from '../netelip/captacion/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';

const opciones = (nombres: string[]) => nombres.map((name, i) => ({ id: `op-${name}`, name, orderindex: i }));
const CAMPOS: CampoLista[] = [
  { id: 'f-cat', name: NOMBRES_CAMPOS.categoria, type: 'drop_down', opciones: opciones(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto']) },
  { id: 'f-pres', name: NOMBRES_CAMPOS.presupuesto, type: 'currency', opciones: [] },
  { id: 'f-pond', name: NOMBRES_CAMPOS.ponderado, type: 'currency', opciones: [] },
  { id: 'f-fuente', name: NOMBRES_CAMPOS.fuente_presupuesto, type: 'drop_down', opciones: opciones(['Formulario', 'Llamada', 'Reunión', 'WhatsApp', 'Fase 2 LYN', 'Manual', 'Pendiente: preguntar en la 1ª llamada']) },
  { id: 'f-idx', name: NOMBRES_CAMPOS.indice_orden, type: 'number', opciones: [] },
  { id: 'f-des', name: NOMBRES_CAMPOS.desglose, type: 'short_text', opciones: [] },
];
const ID_DE: Record<string, string> = Object.fromEntries(CAMPOS.map((c) => [c.id, c.name]));

const FORMULARIO = { menos40: 'Menos de 40.000 €', de40a100: '40.000 € - 100.000 €' };

/** ClickUp en memoria: devuelve las tarjetas tal como están y las escrituras las cambian. */
class ClickUpMemoria {
  tareas: TareaClickUp[] = [];
  campos_: CampoLista[] = CAMPOS;
  escrituras: Array<{ tarea: string; campo: string; valor: string | number }> = [];
  /** Número de escritura (1, 2…) que falla UNA vez (con `errorDeFalla`). */
  fallaEn: number | null = null;
  errorDeFalla: Error = new Error('ClickUp respondió 500');
  llamadas = 0;
  async campos(): Promise<CampoLista[]> { return this.campos_; }
  async *tareas_(): AsyncGenerator<TareaClickUp> { for (const t of this.tareas) yield { ...t, campos: { ...t.campos } }; }
  tareasGen = (): AsyncGenerator<TareaClickUp> => this.tareas_();
  async escribirCampo(tarea: string, campoId: string, valor: string | number): Promise<void> {
    this.llamadas += 1;
    if (this.fallaEn === this.llamadas) {
      this.fallaEn = null;
      throw this.errorDeFalla;
    }
    this.escrituras.push({ tarea, campo: ID_DE[campoId] ?? campoId, valor });
    const t = this.tareas.find((x) => x.id === tarea)!;
    const campo = CAMPOS.find((c) => c.id === campoId)!;
    t.campos[campo.name] = campo.opciones.length ? campo.opciones.find((o) => o.id === valor)!.name : valor;
  }
  get cliente() {
    return { campos: () => this.campos(), tareas: () => this.tareasGen(), escribirCampo: (t: string, c: string, v: string | number) => this.escribirCampo(t, c, v) };
  }
}

const lead = (id: string, extra: Partial<TareaClickUp> & { campos?: TareaClickUp['campos'] } = {}): TareaClickUp => ({
  id, nombre: `Lead ${id}`, esPadre: true, estado: 'en curso', cerrada: false, creadaEn: Date.UTC(2026, 9, 1), ...extra,
  campos: { ETAPA_CRM: 'e3. VIABILIDAD', ...extra.campos },
});

describe.skipIf(!hayBaseDePruebas)('captación · carga inicial · de punta a punta', () => {
  let base: BaseAislada;
  let pool: Pool;
  let ck: ClickUpMemoria;
  const FECHA = new Date('2026-11-17T12:00:00.000Z');

  beforeEach(async () => {
    base = await abrirBaseAislada();
    await ensureCaptacion(base);
    pool = { connect: async () => ({ query: (sql: string, params?: unknown[]) => base.query(sql, params), release: () => undefined }) } as unknown as Pool;
    ck = new ClickUpMemoria();
  });
  afterEach(async () => {
    await base.cerrar();
  });

  const cargar = (extra: { escribirMaximo?: number } = {}) => ejecutarCargaInicial({ pool, cliente: ck.cliente, fechaCarga: FECHA, ...extra });
  const contar = async (tabla: string): Promise<number> => Number((await base.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]?.n);
  const fila = (i: InformeCarga, id: string) => i.filas.find((f) => f.clickupTaskId === id)!;

  /** Cinco leads vivos de los casos que hay en la lista real, y cuatro que no se tocan. */
  const sembrar = () => {
    // A propósito sin orden: el informe sale ordenado por id.
    ck.tareas = [
      lead('x-ganado', { campos: { ETAPA_CRM: 'e14. GANADO' } }),
      lead('e-nc', { campos: { 'No continuidad': 'Presupuesto insuficiente', presupuesto_estimado: 80000 } }),
      lead('c-importe', { campos: { 'Presupuesto formulario': FORMULARIO.menos40, presupuesto_estimado: 150000 } }),
      lead('x-sub', { esPadre: false }),
      lead('a-form', { campos: { 'Presupuesto formulario': FORMULARIO.de40a100 } }),
      lead('f-otro', { campos: { 'No continuidad': 'Otro motivo' } }),
      lead('x-cerrada', { cerrada: true }),
      lead('d-cat', { campos: { valoracion_interna: 'B', presupuesto_estimado: 50000 } }),
      lead('x-sin-etapa', { campos: { ETAPA_CRM: null } }),
      lead('b-nada'),
    ];
  };

  it('simulacro: da de alta a los leads vivos con su categoría, presupuesto y fuente, y NO escribe nada en ClickUp', async () => {
    sembrar();
    const i = await cargar();
    expect(i.filas.map((f) => f.clickupTaskId)).toEqual(['a-form', 'b-nada', 'c-importe', 'd-cat', 'e-nc', 'f-otro']);
    expect(fila(i, 'a-form')).toMatchObject({ accion: 'alta', categoria: 'sin_calificar', presupuesto: 70000, fuente: 'Formulario', ponderado: null, sinPresupuesto: false });
    expect(fila(i, 'b-nada')).toMatchObject({ accion: 'alta', categoria: 'sin_calificar', presupuesto: null, fuente: 'Pendiente: preguntar en la 1ª llamada', ponderado: null, sinPresupuesto: true });
    // El importe que ya tenía la tarjeta manda sobre el del formulario (cuenta como «Manual» con la fecha de la carga).
    expect(fila(i, 'c-importe')).toMatchObject({ categoria: 'sin_calificar', presupuesto: 150000, fuente: 'Manual' });
    expect(fila(i, 'd-cat')).toMatchObject({ categoria: 'B', presupuesto: 50000, ponderado: 37500, fuente: 'Manual' });
    expect(fila(i, 'e-nc')).toMatchObject({ categoria: 'no_apto', presupuesto: 80000, ponderado: 0 });
    // Otro motivo de No continuidad no es No apto.
    expect(fila(i, 'f-otro')).toMatchObject({ categoria: 'sin_calificar', presupuesto: null, ponderado: null, sinPresupuesto: true });
    expect(i.filas.every((f) => f.escritura === 'simulado' && f.campos > 0)).toBe(true);
    expect(ck.escrituras).toEqual([]);
    expect(i.resumen).toMatchObject({
      leadsEnLista: 9, leadsVivos: 6, altas: 6, yaCargadas: 0, sinPresupuesto: 2, simulados: 6, escritos: 0, sinCupo: 0, alDia: 0, errores: 0,
      porCategoria: { sin_calificar: 4, B: 1, no_apto: 1 },
    });
  });

  it('guarda el histórico de cada alta, los presupuestos con su fuente y fecha, y el No apto marcado a mano', async () => {
    sembrar();
    await cargar();
    expect((await base.query('SELECT clickup_task_id AS id, categoria, motivo FROM lead_calificacion_historial ORDER BY clickup_task_id')).rows).toEqual([
      { id: 'a-form', categoria: 'sin_calificar', motivo: 'alta' }, { id: 'b-nada', categoria: 'sin_calificar', motivo: 'alta' },
      { id: 'c-importe', categoria: 'sin_calificar', motivo: 'alta' }, { id: 'd-cat', categoria: 'B', motivo: 'alta' }, { id: 'e-nc', categoria: 'no_apto', motivo: 'alta' },
      { id: 'f-otro', categoria: 'sin_calificar', motivo: 'alta' },
    ]);
    const presupuestos = (await base.query('SELECT clickup_task_id AS id, fuente, valor_vigente::int AS v, fecha_interaccion, registrado_por FROM lead_presupuesto_evento ORDER BY clickup_task_id, fuente')).rows;
    expect(presupuestos.map((p) => [p.id, p.fuente, p.v, p.registrado_por])).toEqual([
      ['a-form', 'formulario', 70000, 'sistema'], ['c-importe', 'formulario', 20000, 'sistema'], ['c-importe', 'manual', 150000, 'usuario'],
      ['d-cat', 'manual', 50000, 'usuario'], ['e-nc', 'manual', 80000, 'usuario'],
    ]);
    expect(new Date(String(presupuestos.find((p) => p.fuente === 'manual')!.fecha_interaccion)).toISOString()).toBe(FECHA.toISOString());
    expect(new Date(String(presupuestos.find((p) => p.fuente === 'formulario')!.fecha_interaccion)).toISOString()).toBe(new Date(Date.UTC(2026, 9, 1)).toISOString());
    expect((await base.query('SELECT clickup_task_id AS id, valor, registrado_por, usuario_id FROM lead_no_apto_evento')).rows).toEqual([
      { id: 'e-nc', valor: true, registrado_por: 'usuario', usuario_id: 'carga-inicial' },
    ]);
  });

  it('con tope escribe solo en esas tarjetas y las demás quedan «sin cupo»; repetir completa el resto sin duplicar nada', async () => {
    sembrar();
    const primera = await cargar({ escribirMaximo: 2 });
    expect(primera.filas.map((f) => f.escritura)).toEqual(['escrito', 'escrito', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo']);
    expect(primera.resumen).toMatchObject({ escritos: 2, sinCupo: 4, simulados: 0 });
    // Cuenta los campos escritos (a-form: categoría, presupuesto, fuente, índice; b-nada: sin presupuesto, 3) y los que quedan pendientes.
    expect(primera.filas.filter((f) => f.escritura === 'escrito').map((f) => f.campos)).toEqual([4, 3]);
    expect(primera.filas.filter((f) => f.escritura === 'sin_cupo').every((f) => f.campos > 0)).toBe(true);
    expect(ck.tareas.find((t) => t.id === 'a-form')!.campos).toMatchObject({
      valoracion_interna: 'Sin calificar', presupuesto_estimado: 70000, 'Fuente del presupuesto': 'Formulario', 'Índice de orden': indiceOrdenDe('sin_calificar', null),
    });
    expect(ck.tareas.find((t) => t.id === 'c-importe')!.campos.valoracion_interna).toBeUndefined();

    const historial = await contar('lead_calificacion_historial');
    const presupuestos = await contar('lead_presupuesto_evento');
    const segunda = await cargar({ escribirMaximo: 10 });
    expect(segunda.filas.map((f) => [f.accion, f.escritura])).toEqual([['ya_cargada', 'al_dia'], ['ya_cargada', 'al_dia'], ['ya_cargada', 'escrito'], ['ya_cargada', 'escrito'], ['ya_cargada', 'escrito'], ['ya_cargada', 'escrito']]);
    expect(segunda.resumen).toMatchObject({ altas: 0, yaCargadas: 6, escritos: 4, alDia: 2 });
    expect(await contar('lead_calificacion_historial')).toBe(historial);
    expect(await contar('lead_presupuesto_evento')).toBe(presupuestos);

    const escritosAntes = ck.escrituras.length;
    const tercera = await cargar({ escribirMaximo: 10 });
    expect(tercera.resumen).toMatchObject({ altas: 0, yaCargadas: 6, escritos: 0, alDia: 6, simulados: 0, errores: 0 });
    expect(ck.escrituras.length).toBe(escritosAntes);
    expect(ck.tareas.find((t) => t.id === 'e-nc')!.campos).toMatchObject({ valoracion_interna: 'No apto', valor_del_negocio: 0 });
    expect(ck.tareas.find((t) => t.id === 'd-cat')!.campos).toMatchObject({ valoracion_interna: 'B', valor_del_negocio: 37500, 'Índice de orden': indiceOrdenDe('B', 37500) });
  });

  it('el tope cuenta tarjetas, no campos, y una tarjeta que ya está al día no gasta cupo', async () => {
    sembrar();
    await cargar({ escribirMaximo: 1 });
    expect(new Set(ck.escrituras.map((e) => e.tarea)).size).toBe(1);
    const i = await cargar({ escribirMaximo: 1 });
    expect(i.filas.map((f) => f.escritura)).toEqual(['al_dia', 'escrito', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo']);
  });

  it('solo escribe los campos que difieren de la tarjeta', async () => {
    ck.tareas = [lead('a-form', { campos: { 'Presupuesto formulario': FORMULARIO.de40a100, valoracion_interna: 'Sin calificar', presupuesto_estimado: 70000, 'Fuente del presupuesto': 'Manual' } })];
    await cargar({ escribirMaximo: 5 });
    expect(ck.escrituras.map((e) => e.campo)).toEqual([NOMBRES_CAMPOS.indice_orden]);
  });

  it('un lead ya dado de alta por otro camino se completa en ClickUp sin darlo de alta otra vez', async () => {
    ck.tareas = [lead('a-form', { campos: { 'Presupuesto formulario': FORMULARIO.de40a100 } })];
    await cargar();
    ck.tareas = [lead('a-form', { campos: { 'Presupuesto formulario': FORMULARIO.de40a100, valoracion_interna: 'C', 'Fuente del presupuesto': 'Llamada', presupuesto_estimado: 1 } })];
    const i = await cargar({ escribirMaximo: 5 });
    expect(fila(i, 'a-form')).toMatchObject({ accion: 'ya_cargada', escritura: 'escrito' });
    expect(ck.tareas[0]!.campos).toMatchObject({ valoracion_interna: 'Sin calificar', presupuesto_estimado: 70000, 'Fuente del presupuesto': 'Formulario' });
    expect(await contar('lead_calificacion_historial')).toBe(1);
  });

  it('si falta un campo en la lista, informa del error por lead, deja las altas guardadas y no gasta cupo', async () => {
    sembrar();
    ck.campos_ = CAMPOS.filter((c) => c.name !== NOMBRES_CAMPOS.ponderado);
    const i = await cargar({ escribirMaximo: 5 });
    expect(i.resumen).toMatchObject({ altas: 6, errores: 6, escritos: 0 });
    expect(fila(i, 'a-form')).toMatchObject({ escritura: 'error', campos: 0, detalle: `La lista no tiene el campo «${NOMBRES_CAMPOS.ponderado}»` });
    expect(ck.escrituras).toEqual([]);
    expect(await contar('lead_calificacion_historial')).toBe(6);
    // Con el campo creado, repetir lo escribe todo.
    ck.campos_ = CAMPOS;
    expect((await cargar({ escribirMaximo: 10 })).resumen).toMatchObject({ altas: 0, escritos: 6, errores: 0 });
  });

  it('también avisa del campo que falta en el simulacro (antes de escribir nada)', async () => {
    ck.tareas = [lead('a-form')];
    ck.campos_ = CAMPOS.filter((c) => c.name !== NOMBRES_CAMPOS.categoria);
    const i = await cargar();
    expect(fila(i, 'a-form')).toMatchObject({ escritura: 'error', detalle: expect.stringContaining('valoracion_interna') });
  });

  it('una escritura que falla a mitad deja constancia de lo escrito y consume cupo; la siguiente tarjeta sigue', async () => {
    sembrar();
    ck.fallaEn = 2;
    const i = await cargar({ escribirMaximo: 2 });
    expect(fila(i, 'a-form')).toMatchObject({ escritura: 'error', campos: 1, detalle: expect.stringContaining('escritura parcial: 1 de') });
    expect(i.filas.map((f) => f.escritura)).toEqual(['error', 'escrito', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo']);
    // Reparar: lo que falte se completa.
    ck.fallaEn = null;
    const r = await cargar({ escribirMaximo: 10 });
    expect(r.resumen).toMatchObject({ errores: 0, escritos: 5, alDia: 1 });
  });

  it('si ClickUp rechaza la primera escritura con un 4xx, no se aplicó nada y no consume cupo', async () => {
    sembrar();
    ck.fallaEn = 1;
    ck.errorDeFalla = new ClickUpError('ClickUp respondió 403 en POST /task/a-form/field/f-cat', 403, false);
    const i = await cargar({ escribirMaximo: 1 });
    expect(fila(i, 'a-form')).toMatchObject({ escritura: 'error', campos: 0, detalle: expect.stringContaining('403') });
    expect(i.filas.map((f) => f.escritura)).toEqual(['error', 'escrito', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo']);
  });

  it.each([
    ['un corte de red (sin respuesta)', new ClickUpError('sin respuesta de ClickUp: TimeoutError', null, true)],
    ['un 5xx', new ClickUpError('ClickUp respondió 502 en POST /task/a-form/field/f-cat', 502, true)],
    ['un error que no es de ClickUp', new Error('algo raro')],
  ])('si falla la primera escritura por %s, pudo haberse aplicado: consume cupo y no se pasa del tope', async (_n, error) => {
    sembrar();
    ck.fallaEn = 1;
    ck.errorDeFalla = error;
    const i = await cargar({ escribirMaximo: 1 });
    expect(fila(i, 'a-form')).toMatchObject({ escritura: 'error', campos: 0 });
    expect(i.filas.map((f) => f.escritura)).toEqual(['error', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo', 'sin_cupo']);
    expect(ck.escrituras).toEqual([]);
  });

  it('cada lead se bloquea al empezar su transacción, antes de mirar su historial', async () => {
    ck.tareas = [lead('a-form')];
    const sqls: Array<{ sql: string; params?: unknown[] }> = [];
    const espia = { connect: async () => ({
      query: (sql: string, params?: unknown[]) => { sqls.push({ sql, params }); return base.query(sql, params); },
      release: () => undefined,
    }) } as unknown as Pool;
    await ejecutarCargaInicial({ pool: espia, cliente: ck.cliente, fechaCarga: FECHA });
    expect(sqls[0]!.sql).toBe('BEGIN');
    expect(sqls[1]!.sql).toContain('pg_advisory_xact_lock');
    expect(sqls[1]!.params).toEqual([7101, 'a-form']);
    expect(sqls[2]!.sql).toContain('lead_calificacion_historial');
  });

  it('si la base falla a mitad de un lead, no queda a medias: lo anterior se conserva y el reintento lo completa', async () => {
    sembrar();
    const rota = { connect: async () => ({
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO lead_calificacion_historial') && params?.[0] === 'c-importe') return Promise.reject(new Error('conexión perdida'));
        return base.query(sql, params);
      },
      release: () => undefined,
    }) } as unknown as Pool;
    await expect(ejecutarCargaInicial({ pool: rota, cliente: ck.cliente, fechaCarga: FECHA })).rejects.toThrow('conexión perdida');
    expect(await contar('lead_calificacion_historial')).toBe(2);
    expect((await base.query("SELECT 1 FROM lead_presupuesto_evento WHERE clickup_task_id = 'c-importe'")).rows).toEqual([]);
    const i = await cargar();
    expect(i.resumen).toMatchObject({ altas: 4, yaCargadas: 2 });
    expect(await contar('lead_calificacion_historial')).toBe(6);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('un tope inválido (%s) se rechaza antes de tocar nada', async (tope) => {
    sembrar();
    await expect(cargar({ escribirMaximo: tope })).rejects.toThrow('escribirMaximo debe ser un entero de 0 o más');
    expect(await contar('lead_calificacion_historial')).toBe(0);
    expect(ck.escrituras).toEqual([]);
  });

  it('una lista sin leads vivos da un informe vacío', async () => {
    ck.tareas = [lead('x', { campos: { ETAPA_CRM: 'e15. PERDIDO' } })];
    const i = await cargar();
    expect(i.filas).toEqual([]);
    expect(i.resumen).toMatchObject({ leadsEnLista: 1, leadsVivos: 0, altas: 0, porCategoria: {} });
  });

  it('el listado de sin presupuesto sale en el CSV y en el resumen, y el nombre con fórmula se neutraliza', async () => {
    ck.tareas = [lead('a-form', { nombre: '=HYPERLINK("http://x")', campos: { 'Presupuesto formulario': FORMULARIO.menos40 } }), lead('b-nada', { nombre: 'Ana; "la Grande"' })];
    const i = await cargar();
    const csv = informeCsvCarga(i);
    expect(csv.startsWith('\uFEFFlead_id;lead;etapa;accion;categoria;presupuesto;fuente;ponderado;sin_presupuesto;escritura;campos;detalle\r\n')).toBe(true);
    const lineas = csv.trimEnd().split('\r\n');
    expect(lineas[1]).toBe('a-form;"\'=HYPERLINK(""http://x"")";e3. VIABILIDAD;alta;sin_calificar;20000;Formulario;;no;simulado;4;');
    expect(lineas[2]).toBe('b-nada;"Ana; ""la Grande""";e3. VIABILIDAD;alta;sin_calificar;;Pendiente: preguntar en la 1ª llamada;;sí;simulado;3;');
    expect(resumenCarga(i)).toBe([
      'Leads en la lista: 2 (vivos 2) · Altas nuevas: 2 · Ya cargadas: 0 · Sin presupuesto: 1',
      'Por categoría: sin_calificar 2',
      'Escritura en ClickUp: 0 tarjetas escritas · 2 en simulacro · 0 sin cupo · 0 ya al día · 0 con error',
    ].join('\n'));
  });

  it('el resumen cita los motivos de error (sin repetirlos)', async () => {
    ck.tareas = [lead('a'), lead('b')];
    ck.campos_ = CAMPOS.filter((c) => c.name !== NOMBRES_CAMPOS.ponderado);
    const informe = await cargar();
    const texto = resumenCarga(informe);
    expect(informe.filas.map((f) => f.detalle)).toEqual(Array(2).fill('La lista no tiene el campo «valor_del_negocio»'));
    // El detalle del error también va en el CSV (última columna).
    expect(informeCsvCarga(informe).trimEnd().split('\r\n')[1]).toBe('a;Lead a;e3. VIABILIDAD;alta;sin_calificar;;Pendiente: preguntar en la 1ª llamada;;sí;error;0;La lista no tiene el campo «valor_del_negocio»');
    expect(texto).toContain('2 con error');
    expect(texto.match(/Motivos de error: (.*)$/m)![1]).toBe('La lista no tiene el campo «valor_del_negocio»');
  });
});

// ---------------------------------------------------------------------------------------------
// Ejecutable: argumentos y protecciones de arranque (sin base de datos ni red)
// ---------------------------------------------------------------------------------------------

describe('captación · carga inicial · argumentos', () => {
  const base = ['--informe', 'C:/fuera/informe.csv'];
  it('lee el informe y los valores por defecto', () => {
    expect(leerArgumentosCarga(base)).toEqual({ informe: 'C:/fuera/informe.csv', escribir: 0, confirmoCopia: false, baseReal: false });
  });
  it('lee el tope de escritura y las confirmaciones', () => {
    expect(leerArgumentosCarga([...base, '--escribir', '10', '--confirmo-copia'])).toMatchObject({ escribir: 10, confirmoCopia: true, baseReal: false });
    expect(leerArgumentosCarga([...base, '--escribir', '0', '--base-real'])).toMatchObject({ escribir: 0, baseReal: true, confirmoCopia: false });
  });
  it.each([
    ['sin --informe', [], 'Falta --informe'],
    ['--escribir negativo', [...base, '--escribir', '-1'], '--escribir debe ser un número entero'],
    ['--escribir con decimales', [...base, '--escribir', '2.5'], '--escribir debe ser un número entero'],
    ['--escribir con 400 dígitos', [...base, '--escribir', '9'.repeat(400)], '--escribir debe ser un número entero'],
    ['--escribir por encima del entero seguro', [...base, '--escribir', '9007199254740992'], '--escribir debe ser un número entero'],
    ['las dos confirmaciones a la vez', [...base, '--confirmo-copia', '--base-real'], 'se excluyen'],
    ['opción desconocida', [...base, '--fuerza'], 'Argumento desconocido: --fuerza'],
    ['valor suelto', [...base, 'sobra'], 'Argumento inesperado: sobra'],
    ['opción sin valor', ['--informe'], 'Falta el valor de --informe'],
    ['el valor de una opción es otra opción', ['--informe', '--escribir', '3'], 'Falta el valor de --informe'],
  ])('rechaza: %s', (_n, argv, mensaje) => {
    expect(() => leerArgumentosCarga(argv)).toThrow(mensaje);
  });
});

describe('captación · carga inicial · protecciones de arranque', () => {
  const informe = ['--informe', 'C:/fuera/informe.csv'];
  const completo = { CLICKUP_API_TOKEN: 'pk_x', CAPTACION_CLICKUP_LIST_ID: '123' };
  it('sin DATABASE_URL no arranca', async () => {
    await expect(mainCarga(informe, completo)).rejects.toThrow('Falta DATABASE_URL');
  });
  it('una base que no parece de pruebas exige --confirmo-copia o --base-real', async () => {
    for (const url of ['postgres://u:p@db.ejemplo.com/superagente', 'postgres://u:p@127.0.0.1:5432/superagente']) {
      await expect(mainCarga(informe, { ...completo, DATABASE_URL: url })).rejects.toThrow('no parece una base de pruebas');
    }
  });
  it('con la confirmación pasa la protección y se detiene en lo siguiente que falta (sin conectar a nada)', async () => {
    const env = { DATABASE_URL: 'postgres://u:p@db.ejemplo.com/superagente', CLICKUP_API_TOKEN: '', CAPTACION_CLICKUP_LIST_ID: '' };
    await expect(mainCarga([...informe, '--confirmo-copia'], env)).rejects.toThrow('Faltan CLICKUP_API_TOKEN');
    await expect(mainCarga([...informe, '--base-real'], env)).rejects.toThrow('Faltan CLICKUP_API_TOKEN');
  });
  it('una base local con nombre de copia no necesita confirmación', async () => {
    const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/superagente_copia', CLICKUP_API_TOKEN: '', CAPTACION_CLICKUP_LIST_ID: '' };
    await expect(mainCarga(informe, env)).rejects.toThrow('Faltan CLICKUP_API_TOKEN');
  });
});
