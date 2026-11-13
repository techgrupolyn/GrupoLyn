// Lote de captación ABCD de punta a punta: tablas reales de Netelip (las crea ensureNetelipCalls del repo) +
// tablas de la captación + ClickUp falso por HTTP + modelo falso. Sin red real y sin tocar ClickUp.
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RespuestaModelo } from '../netelip/calificador/modelo.ts';
import { ClickUpClient, ESCALA_ORDEN, RANGO_ORDEN } from '../netelip/captacion/clickup.ts';
import { ejecutarLote, esVivo, type OpcionesLote } from '../netelip/captacion/lote.ts';
import { registrarPresupuestoFormulario } from '../netelip/captacion/repositorio.ts';
import { ensureNetelipCalls } from '../netelip/schema.ts';
import { abrirBaseAislada, hayBaseDePruebas, type BaseAislada } from './helpers/captacion-base.ts';
import { FRASE, salidaModelo, TRANSCRIPCION_BASE, type OpcionesSalida } from './helpers/captacion-llamadas.ts';
import { levantarClickUpFalso, LISTA_FALSA, TOKEN_FALSO, type ClickUpFalso, type TareaFalsa } from './helpers/clickup-falso.ts';

const DESDE = new Date('2026-11-01T00:00:00Z');
const HASTA = new Date('2026-11-13T00:00:00Z');
const ETAPA = { en_espera: 0, viabilidad: 1, visita: 2, rechazado: 3, perdido: 4 };

describe('captación · lote · qué es un lead vivo', () => {
  const tarea = (etapa: string | null, cerrada = false) =>
    ({ id: 't', nombre: 'x', esPadre: true, estado: 's', cerrada, creadaEn: 0, campos: { ETAPA_CRM: etapa } }) as Parameters<typeof esVivo>[0];
  // Nombres reales de ETAPA_CRM en «Contacto de Reforma» (12/11/2026).
  it('vivo = tarea abierta y etapa de e1 a e13', () => {
    for (const etapa of ['e1. EN ESPERA', 'e3. VIABILIDAD', 'e9. 1a PRESENTACIÓN', 'e13. CONFIRMACIÓN RESULTADO', 'E4. visita', '  e11. SEGUIMIENTO']) {
      expect(esVivo(tarea(etapa)), etapa).toBe(true);
    }
  });
  it('GANADO, PERDIDO, RECHAZADO, PASE, etapas fuera de rango, sin etapa o con la tarea cerrada no están vivos', () => {
    for (const etapa of ['e14. GANADO', 'e15. PERDIDO', 'e16. RECHAZADO', 'e18. PASE', 'e0. NADA', 'e99. OTRA', 'RECHAZADO', null, '']) {
      expect(esVivo(tarea(etapa)), String(etapa)).toBe(false);
    }
    expect(esVivo(tarea('e3. VIABILIDAD', true))).toBe(false);
  });
});

describe.skipIf(!hayBaseDePruebas)('captación · lote · de punta a punta', () => {
  let base: BaseAislada;
  let pool: Pool;
  let falso: ClickUpFalso;
  let cliente: ClickUpClient;
  const guiones = new Map<string, OpcionesSalida>();
  const prompts: string[] = [];
  let fallos = 0;
  let respuestasMalas = 0;

  const evaluar = async (_sistema: string, usuario: string): Promise<RespuestaModelo> => {
    prompts.push(usuario);
    if (fallos > 0) {
      fallos -= 1;
      throw new Error('Gemini respondió HTTP 503');
    }
    if (respuestasMalas > 0) {
      respuestasMalas -= 1;
      return { text: 'esto no es JSON', model: 'gemini-falso', inputTokens: 1, outputTokens: 1 };
    }
    const id = /interaccion_id (\S+)/.exec(usuario)![1]!;
    const llamada = id.split(':')[1]!;
    return { text: salidaModelo(id, guiones.get(llamada)), model: 'gemini-falso', inputTokens: 1000, outputTokens: 200 };
  };

  beforeEach(async () => {
    base = await abrirBaseAislada();
    // Con una sola conexión, el «pool» es esa conexión: así todo cae en el esquema aislado de la prueba.
    pool = { query: (sql: string, params?: unknown[]) => base.query(sql, params), connect: async () => ({ query: (sql: string, params?: unknown[]) => base.query(sql, params), release: () => undefined }) } as unknown as Pool;
    await base.exec(`
      CREATE TABLE empleados (id VARCHAR(255) PRIMARY KEY, nombre TEXT);
      CREATE TABLE clientes (id VARCHAR(255) PRIMARY KEY, nombre TEXT, apellido TEXT);
      CREATE TABLE crm_leads (id UUID PRIMARY KEY, name TEXT);
    `);
    await ensureNetelipCalls(pool);
    falso = await levantarClickUpFalso();
    cliente = new ClickUpClient({ token: TOKEN_FALSO, listaId: LISTA_FALSA, baseUrl: falso.base, pausaMs: 0, esperar: async () => undefined });
    guiones.clear();
    prompts.length = 0;
    fallos = 0;
    respuestasMalas = 0;
  });
  afterEach(async () => {
    await falso.cerrar();
    await base.cerrar();
  });

  const llamada = async (o: { id: string; telefono: string | null; ocurrida?: string; duracion?: number; estado?: string; texto?: string; segments?: unknown }): Promise<string> => {
    const r = await base.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, phone_e164, contact_status, duration_seconds, call_status, received_at)
       VALUES ($1, 'outbound', $2, 'uniqueid', $3, $4, 'unknown', $5, 'ANSWERED', now()) RETURNING id`,
      [o.id, o.ocurrida ?? '2026-11-10T10:00:00Z', o.telefono ?? 'anonymous', o.telefono, o.duracion ?? 240],
    );
    const id = String(r.rows[0]!.id);
    await base.query('INSERT INTO netelip_call_transcriptions (call_id, status, text, segments) VALUES ($1, $2, $3, $4)',
      [id, o.estado ?? 'completed', o.texto ?? TRANSCRIPCION_BASE, o.segments === undefined ? null : JSON.stringify(o.segments)]);
    return id;
  };
  const lote = (extra: Partial<OpcionesLote> = {}) => ejecutarLote({ pool, cliente, evaluar, desde: DESDE, hasta: HASTA, esperar: async () => undefined, ...extra });
  const tareas = (...t: TareaFalsa[]) => { falso.tareas = t; };
  const posts = () => falso.peticiones.filter((p) => p.metodo !== 'GET');
  const contar = async (tabla: string): Promise<number> => Number((await base.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]?.n);

  it('simulacro: califica la llamada de un lead vivo, anota el resto y NO escribe nada en ClickUp', async () => {
    tareas({ id: 'ana', nombre: 'Ana Beltrán', telefono: '+34600111222', etapa: ETAPA.viabilidad, tipoContacto: 0 });
    const buena = await llamada({ id: 'u1', telefono: '+34600111222' });
    await llamada({ id: 'u2', telefono: '+34699000111' });
    await llamada({ id: 'u3', telefono: '+34600111222', ocurrida: '2026-10-20T10:00:00Z' });
    await llamada({ id: 'u4', telefono: '+34600111222', duracion: 40 });
    await llamada({ id: 'u5', telefono: '+34600111222', estado: 'pending' });
    const informe = await lote();
    expect(informe.filas.map((f) => [f.llamadaId, f.estado])).toEqual([[buena, 'procesada'], [String(Number(buena) + 1), 'sin_lead']]);
    expect(informe.filas[0]).toMatchObject({
      lead: { id: 'ana', nombre: 'Ana Beltrán', etapa: 'e3. VIABILIDAD' }, via: 'telefono', categoria: 'A+', intentos: 1, descartes: 0, revisionManual: [],
    });
    // Pres + Urg + Dec = 65 % y, con «Tipo de Contacto» del formulario, el Alcance provisional suma el 10 % que falta.
    expect(informe.filas[0]!.desglose).toContain('Alc A');
    expect(informe.filas[0]!.desglose).toContain('cob. 75 %');
    expect(informe.filas[1]).toMatchObject({ lead: null, motivo: 'sin_coincidencia', categoria: null });
    expect(informe.escrituras).toEqual([{ clickupTaskId: 'ana', nombre: 'Ana Beltrán', resultado: 'simulado', campos: 0, detalle: null }]);
    expect(posts()).toEqual([]);
    expect(informe.resumen).toMatchObject({ leadsEnLista: 1, leadsVivos: 1, llamadas: 2, leadsCalificados: 1, porEstado: { procesada: 1, sin_lead: 1 }, porCategoria: { 'A+': 1 } });
  });

  it('cada fila trae las frases que justifican cada letra, sin los criterios sin información', async () => {
    tareas({ id: 'ana', nombre: 'Ana Beltrán', telefono: '+34600111222', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600111222' });
    const [fila] = (await lote()).filas;
    expect(fila!.citas).toEqual([
      { criterio: 'decisor', nivel: 'A', cita: FRASE.decisor },
      { criterio: 'presupuesto', nivel: 'A', cita: FRASE.presupuesto },
      { criterio: 'urgencia', nivel: 'A', cita: FRASE.urgencia },
    ]);
  });

  it('el nombre del lead de ClickUp no sale hacia el modelo', async () => {
    tareas({ id: 'ana', nombre: 'Ana Beltrán', telefono: '+34600111222', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600111222', texto: `${TRANSCRIPCION_BASE}\n[00:03:00] CLIENTE: Soy Ana Beltrán, encantada.` });
    await lote();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Beltrán');
  });

  it('usa los segmentos con hablante cuando la transcripción los trae', async () => {
    tareas({ id: 'ana', nombre: 'Ana Beltrán', telefono: '+34600111222', etapa: ETAPA.viabilidad });
    const segmentos = [
      { speaker: 'agente', start: 5, end: 9, text: 'Hola, soy Laura de Grupo LYN, te llamo por la reforma.' },
      { speaker: 'cliente', start: 70, end: 80, text: `${FRASE.urgencia}.` },
      { speaker: 'cliente', start: 100, end: 110, text: `${FRASE.decisor}.` },
      { speaker: 'cliente', start: 130, end: 140, text: `${FRASE.presupuesto}.` },
    ];
    await llamada({ id: 'u1', telefono: '+34600111222', texto: 'texto plano que no debe usarse', segments: segmentos });
    const [fila] = (await lote()).filas;
    expect(fila).toMatchObject({ estado: 'procesada', categoria: 'A+' });
    expect(prompts[0]).toContain('[00:01:10] CLIENTE:');
    expect(prompts[0]).not.toContain('texto plano');
  });

  it('candidatos «vivos» (por defecto) resuelve un teléfono repetido si solo una tarea sigue viva; «todos» aplica la regla del ticket', async () => {
    tareas(
      { id: 'viva', nombre: 'Lead vivo', telefono: '+34611333444', etapa: ETAPA.viabilidad },
      // En ClickUp real la mayoría de los RECHAZADO/PERDIDO no tienen la tarea cerrada: solo lo dice la etapa.
      { id: 'muerta', nombre: 'Lead muerto', telefono: '+34611333444', etapa: ETAPA.rechazado },
    );
    await llamada({ id: 'u1', telefono: '+34611333444' });
    expect((await lote()).filas[0]).toMatchObject({ estado: 'procesada', lead: { id: 'viva' } });
    expect((await lote({ candidatos: 'todos' })).filas[0]).toMatchObject({ estado: 'sin_lead', motivo: 'varias_coincidencias' });
  });

  it('dos tareas vivas con el mismo teléfono siguen siendo ambiguas: sin lead', async () => {
    tareas(
      { id: 'a', nombre: 'A', telefono: '+34611333444', etapa: ETAPA.viabilidad },
      { id: 'b', nombre: 'B', telefono: '+34611333444', etapa: ETAPA.visita },
    );
    await llamada({ id: 'u1', telefono: '+34611333444' });
    expect((await lote()).filas[0]).toMatchObject({ estado: 'sin_lead', motivo: 'varias_coincidencias' });
  });

  it('escribe en ClickUp solo hasta el tope indicado y una vez por lead, con su estado final', async () => {
    tareas(
      { id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'l2', nombre: 'Lead 2', telefono: '+34600000002', etapa: ETAPA.viabilidad },
      { id: 'l3', nombre: 'Lead 3', telefono: '+34600000003', etapa: ETAPA.viabilidad },
    );
    // El lead 1 tiene dos llamadas: se escribe solo la letra de la última (la primera era peor).
    const primera = await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-03T10:00:00Z' });
    await llamada({ id: 'u1b', telefono: '+34600000001', ocurrida: '2026-11-05T10:00:00Z' });
    await llamada({ id: 'u2', telefono: '+34600000002' });
    await llamada({ id: 'u3', telefono: '+34600000003' });
    guiones.set(primera, { nivelDecisor: 'D', plazoMeses: 14 });
    const informe = await lote({ escribirMaximo: 2 });
    expect(informe.escrituras.map((e) => [e.clickupTaskId, e.resultado, e.campos])).toEqual([['l1', 'escrito', 6], ['l2', 'escrito', 6], ['l3', 'sin_cupo', 0]]);
    const escritos = posts();
    expect(escritos).toHaveLength(12);
    expect(new Set(escritos.map((p) => p.ruta.split('/')[2]))).toEqual(new Set(['l1', 'l2']));
    expect(escritos.every((p) => p.metodo === 'POST' && p.auth === TOKEN_FALSO)).toBe(true);
    const deL1 = Object.fromEntries(escritos.filter((p) => p.ruta.startsWith('/task/l1/')).map((p) => [p.ruta.split('/')[4], (p.cuerpo as { value: unknown }).value]));
    // A+ con 100.000 € ponderados: rango 6 x 100.000.000 + 100.000.
    expect(deL1).toEqual({ 'f-cat': 'o-cat-0', 'f-fuente': 'o-fuente-1', 'f-pres': 100000, 'f-pond': 100000, 'f-indice': 600_100_000, 'f-desg': expect.stringContaining('cob. 65 %') });
    expect(deL1['f-desg']).toContain('Dec A');
    expect(deL1['f-desg']).not.toContain('Dec D');
  });

  it('de punta a punta: seis leads de letras e importes distintos quedan ordenados por el «Índice de orden» que se escribe en ClickUp', async () => {
    const etiquetasCat = ['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto'];
    const casos: Array<{ id: string; tel: string; salida: OpcionesSalida; categoria: string }> = [
      { id: 'cenorme', tel: '+34600100005', salida: { nivelDecisor: 'C', plazoMeses: 14, presupuesto: { min: 300000, max: 340000 } }, categoria: 'C' },
      { id: 'abajo', tel: '+34600100003', salida: { presupuesto: { min: 40000, max: 60000 } }, categoria: 'A' },
      { id: 'sin', tel: '+34600100006', salida: { presupuesto: null }, categoria: 'sin_calificar' },
      { id: 'benorme', tel: '+34600100004', salida: { nivelDecisor: 'B', plazoMeses: 5, presupuesto: { min: 400000, max: 440000 } }, categoria: 'B' },
      { id: 'aalto', tel: '+34600100002', salida: { presupuesto: { min: 80000, max: 100000 } }, categoria: 'A' },
      { id: 'amas', tel: '+34600100001', salida: {}, categoria: 'A+' },
    ];
    tareas(...casos.map((c) => ({ id: c.id, nombre: `Lead ${c.id}`, telefono: c.tel, etapa: ETAPA.viabilidad })));
    for (const c of casos) guiones.set(await llamada({ id: `u-${c.id}`, telefono: c.tel }), c.salida);

    const informe = await lote({ escribirMaximo: 10 });
    expect(informe.escrituras.map((e) => [e.clickupTaskId, e.resultado, e.detalle])).toEqual(casos.map((c) => [c.id, 'escrito', c.id === 'sin' ? 'presupuesto (sin valor), ponderado (sin valor)' : null]));
    // Cada lead recibe las letras que tocan, aunque el importe de algunos (B y C) sea el mayor de todos.
    expect(Object.fromEntries(informe.filas.map((f) => [f.lead!.id, f.categoria]))).toEqual(Object.fromEntries(casos.map((c) => [c.id, c.categoria])));

    // Lo que ClickUp recibe de cada lead: la letra (id de opción), el ponderado y el índice.
    const recibido = casos.map((c) => {
      const campos = Object.fromEntries(posts().filter((p) => p.ruta.startsWith(`/task/${c.id}/`)).map((p) => [p.ruta.split('/')[4], (p.cuerpo as { value: unknown }).value]));
      return { id: c.id, letra: etiquetasCat[Number(String(campos['f-cat']).split('-')[2])]!, ponderado: campos['f-pond'] as number | undefined, indice: campos['f-indice'] as number };
    });
    // Cinco leads con 6 campos y «sin», que no tiene presupuesto ni ponderado, con 4 (letra, fuente, índice y desglose).
    expect(posts()).toHaveLength(5 * 6 + 4);
    const claveCat: Record<string, keyof typeof RANGO_ORDEN> = { 'A+': 'A+', A: 'A', B: 'B', C: 'C', D: 'D', 'Sin calificar': 'sin_calificar', 'No apto': 'no_apto' };
    for (const r of recibido) expect(r.indice, r.id).toBe(RANGO_ORDEN[claveCat[r.letra]!] * ESCALA_ORDEN + (r.ponderado ?? 0));
    expect(recibido.find((r) => r.id === 'sin')).toMatchObject({ letra: 'Sin calificar', ponderado: undefined, indice: 100_000_000 });
    // Lo que hace el tablero: ordenar por ese número de mayor a menor. Queda por letra y, dentro de cada letra, por importe.
    expect([...recibido].sort((x, y) => y.indice - x.indice).map((r) => r.id)).toEqual(['amas', 'aalto', 'abajo', 'benorme', 'cenorme', 'sin']);
    expect(recibido.find((r) => r.id === 'cenorme')!.ponderado!).toBeGreaterThan(recibido.find((r) => r.id === 'abajo')!.ponderado!);
  });

  it('el simulacro no escribe el índice ni nada más, y con el campo ausente el lote igual termina sin error', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    await lote();
    expect(posts()).toEqual([]);
    falso.campos = falso.campos.filter((c) => c.name !== 'Índice de orden') as typeof falso.campos;
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.escrituras[0]).toMatchObject({ resultado: 'escrito', campos: 5, detalle: 'indice_orden (el campo no existe en la lista)' });
    expect(posts().some((p) => p.ruta.includes('f-indice'))).toBe(false);
  });

  // Lo que ClickUp recibió de una tarjeta: campo → valor del POST.
  const escritoDe = (id: string) =>
    Object.fromEntries(posts().filter((p) => p.ruta.startsWith(`/task/${id}/`)).map((p) => [p.ruta.split('/')[4], (p.cuerpo as { value: unknown }).value]));

  it('presupuesto del formulario: un lead con llamada SIN importe toma el rango que marcó en la web (valor central) como presupuesto del cliente', async () => {
    tareas({ id: 'f1', nombre: 'Lead F1', telefono: '+34600000001', etapa: ETAPA.viabilidad, tipoContacto: 0, presupuestoFormulario: 1 });
    guiones.set(await llamada({ id: 'u1', telefono: '+34600000001' }), { presupuesto: null });
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.resumen.presupuestoFormulario).toBe(1);
    expect(informe.filas[0]).toMatchObject({ estado: 'procesada', categoria: 'A' });
    // «40.000 € - 100.000 €» cuenta como 70.000 €; la fuente que se muestra es «Formulario».
    expect(escritoDe('f1')).toMatchObject({ 'f-pres': 70_000, 'f-pond': 70_000, 'f-fuente': 'o-fuente-0', 'f-indice': 500_070_000 });
  });

  it('«Más de 200.000 €» cuenta como 200.000 € pero NO da A+ si la llamada no dice nada del presupuesto (A+ exige el criterio Presupuesto en A o B)', async () => {
    tareas({ id: 'f2', nombre: 'Lead F2', telefono: '+34600000002', etapa: ETAPA.viabilidad, tipoContacto: 0, presupuestoFormulario: 3 });
    guiones.set(await llamada({ id: 'u2', telefono: '+34600000002' }), { presupuesto: null });
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.filas[0]).toMatchObject({ categoria: 'A' });
    expect(escritoDe('f2')).toMatchObject({ 'f-pres': 200_000, 'f-pond': 200_000 });
  });

  it('un importe que el cliente dice en una llamada posterior sustituye al del formulario (RN-8)', async () => {
    tareas({ id: 'f3', nombre: 'Lead F3', telefono: '+34600000003', etapa: ETAPA.viabilidad, presupuestoFormulario: 0 });
    await llamada({ id: 'u3', telefono: '+34600000003' }); // el cliente dice 90.000–110.000 €
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.filas[0]).toMatchObject({ categoria: 'A+' });
    // «Menos de 40.000 €» (20.000 €) del formulario queda guardado, pero manda la llamada: 100.000 € y fuente «Llamada».
    expect(escritoDe('f3')).toMatchObject({ 'f-pres': 100_000, 'f-pond': 100_000, 'f-fuente': 'o-fuente-1' });
    expect(await contar("lead_presupuesto_evento WHERE fuente = 'formulario'")).toBe(1);
  });

  it('una cifra que dice LYN en la llamada NO pisa al presupuesto del formulario, aunque sea posterior', async () => {
    tareas({ id: 'f4', nombre: 'Lead F4', telefono: '+34600000004', etapa: ETAPA.viabilidad, presupuestoFormulario: 2 });
    guiones.set(await llamada({ id: 'u4', telefono: '+34600000004' }), { presupuesto: { min: 50_000, max: 60_000 }, emisor: 'lyn' });
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.filas[0]).toMatchObject({ categoria: 'A+' });
    expect(escritoDe('f4')).toMatchObject({ 'f-pres': 150_000, 'f-pond': 150_000, 'f-fuente': 'o-fuente-0' });
    expect(await contar("lead_presupuesto_evento WHERE emisor = 'lyn'")).toBe(1);
  });

  it('repetir el lote no duplica el presupuesto del formulario', async () => {
    tareas({ id: 'f5', nombre: 'Lead F5', telefono: '+34600000005', etapa: ETAPA.viabilidad, presupuestoFormulario: 1 });
    await llamada({ id: 'u5', telefono: '+34600000005' });
    expect((await lote()).resumen.presupuestoFormulario).toBe(1);
    expect((await lote()).resumen.presupuestoFormulario).toBe(0);
    expect(await contar("lead_presupuesto_evento WHERE fuente = 'formulario'")).toBe(1);
  });

  it('el formulario solo se registra en leads VIVOS y, sin llamada, deja el dato pero no califica ni escribe nada (sin letra)', async () => {
    tareas(
      { id: 'muerto', nombre: 'Lead muerto', telefono: '+34600000006', etapa: ETAPA.rechazado, presupuestoFormulario: 2 },
      { id: 'sinllamada', nombre: 'Lead sin llamada', telefono: '+34600000007', etapa: ETAPA.viabilidad, presupuestoFormulario: 3 },
    );
    const informe = await lote({ escribirMaximo: 5 });
    expect(informe.resumen.presupuestoFormulario).toBe(1);
    expect(await contar("lead_presupuesto_evento WHERE clickup_task_id = 'muerto'")).toBe(0);
    expect(await contar("lead_presupuesto_evento WHERE clickup_task_id = 'sinllamada'")).toBe(1);
    expect(informe.escrituras).toEqual([]);
    expect(posts()).toEqual([]);
    expect(await contar('lead_calificacion_historial')).toBe(0);
  });

  it('el evento del formulario es del cliente, con la fecha de creación de la tarjeta y la opción elegida como cita', async () => {
    expect(await registrarPresupuestoFormulario(base, { clickupTaskId: 'x1', opcion: '100.000 € - 200.000 €', fechaInteraccion: '2026-11-10T09:00:00.000Z' })).toBe(true);
    expect(await registrarPresupuestoFormulario(base, { clickupTaskId: 'x1', opcion: '100.000 € - 200.000 €', fechaInteraccion: '2026-11-10T09:00:00.000Z' })).toBe(false);
    const { rows } = await base.query('SELECT fuente, tipo, valor_min::int AS min, valor_max::int AS max, valor_vigente::int AS vig, emisor, cita_textual, interaccion_id, registrado_por, fecha_interaccion FROM lead_presupuesto_evento WHERE clickup_task_id = $1', ['x1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fuente: 'formulario', tipo: 'rango', min: 100_000, max: 200_000, vig: 150_000, emisor: 'cliente', cita_textual: '100.000 € - 200.000 €', interaccion_id: 'formulario:x1', registrado_por: 'sistema' });
    expect(new Date(rows[0]!.fecha_interaccion as string).toISOString()).toBe('2026-11-10T09:00:00.000Z');
    // Cada lead tiene su propio evento: otro lead con formulario no choca con el primero.
    expect(await registrarPresupuestoFormulario(base, { clickupTaskId: 'x4', opcion: 'Más de 200.000 €', fechaInteraccion: '2026-11-11T09:00:00.000Z' })).toBe(true);
    expect(await contar("lead_presupuesto_evento WHERE fuente = 'formulario'")).toBe(2);
    // Una opción que no es de las 4 no deja nada guardado.
    expect(await registrarPresupuestoFormulario(base, { clickupTaskId: 'x2', opcion: 'Prefiero no decirlo', fechaInteraccion: '2026-11-10T09:00:00.000Z' })).toBe(false);
    expect(await registrarPresupuestoFormulario(base, { clickupTaskId: 'x3', opcion: null, fechaInteraccion: '2026-11-10T09:00:00.000Z' })).toBe(false);
    expect(await contar("lead_presupuesto_evento WHERE clickup_task_id IN ('x2', 'x3')")).toBe(0);
  });

  const dosLeads = async () => {
    tareas(
      { id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'l2', nombre: 'Lead 2', telefono: '+34600000002', etapa: ETAPA.viabilidad },
    );
    await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-02T10:00:00Z' });
    await llamada({ id: 'u2', telefono: '+34600000002', ocurrida: '2026-11-03T10:00:00Z' });
  };

  it('una escritura a medias (falla el 3.er campo) se informa con los campos que sí quedaron y CONSUME cupo', async () => {
    await dosLeads();
    falso.fallar = (p) => p.ruta === '/task/l1/field/f-pres';
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.escrituras).toEqual([
      { clickupTaskId: 'l1', nombre: 'Lead 1', resultado: 'error', campos: 2, detalle: 'escritura parcial: 2 de 6 campos (ClickUp respondió 404 en POST /task/l1/field/f-pres)' },
      { clickupTaskId: 'l2', nombre: 'Lead 2', resultado: 'sin_cupo', campos: 0, detalle: null },
    ]);
    // Se tocó una sola tarea (l1): tres POST, los dos primeros buenos y el tercero rechazado; nada en l2.
    expect(posts().map((p) => p.ruta)).toEqual(['/task/l1/field/f-cat', '/task/l1/field/f-fuente', '/task/l1/field/f-pres']);
  });

  it('si falla el primer campo no se tocó nada: no consume cupo y el siguiente lead sí se escribe', async () => {
    await dosLeads();
    falso.fallar = (p) => p.ruta === '/task/l1/field/f-cat';
    const informe = await lote({ escribirMaximo: 1 });
    expect(informe.escrituras.map((e) => [e.clickupTaskId, e.resultado, e.campos])).toEqual([['l1', 'error', 0], ['l2', 'escrito', 6]]);
    expect(posts().filter((p) => p.ruta.startsWith('/task/l2/'))).toHaveLength(6);
  });

  it.each([[Number.POSITIVE_INFINITY], [Number.NaN], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])('un tope que no es un entero normal (%s) se rechaza antes de llamar a ClickUp', async (tope) => {
    await dosLeads();
    await expect(lote({ escribirMaximo: tope })).rejects.toThrow('escribirMaximo debe ser un entero de 0 o más');
    expect(falso.peticiones).toEqual([]);
  });

  it('un lead que ya no está vivo NUNCA se escribe (ni con «candidatos todos») y no consume cupo', async () => {
    tareas(
      { id: 'muerta', nombre: 'Lead muerto', telefono: '+34600000009', etapa: ETAPA.rechazado },
      { id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad },
    );
    await llamada({ id: 'u9', telefono: '+34600000009', ocurrida: '2026-11-02T10:00:00Z' });
    await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-03T10:00:00Z' });
    const informe = await lote({ candidatos: 'todos', escribirMaximo: 1 });
    // El lead muerto va primero y no se come el único cupo: el vivo sí se escribe.
    expect(informe.escrituras.map((e) => [e.clickupTaskId, e.resultado, e.campos])).toEqual([['muerta', 'no_vivo', 0], ['l1', 'escrito', 6]]);
    expect(posts().every((p) => p.ruta.startsWith('/task/l1/'))).toBe(true);
    expect(informe.filas.map((f) => f.estado)).toEqual(['procesada', 'procesada']);
    // En simulacro también se marca como no vivo.
    const simulacro = await lote({ candidatos: 'todos' });
    expect(simulacro.escrituras.map((e) => [e.clickupTaskId, e.resultado])).toEqual([['muerta', 'no_vivo'], ['l1', 'simulado']]);
  });

  it('sin el campo opcional «Fuente del presupuesto» se escribe igual (5 campos) y se anota', async () => {
    falso.campos = falso.campos.filter((c) => c.name !== 'Fuente del presupuesto') as typeof falso.campos;
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    const informe = await lote({ escribirMaximo: 5 });
    expect(informe.escrituras).toEqual([{ clickupTaskId: 'l1', nombre: 'Lead 1', resultado: 'escrito', campos: 5, detalle: 'fuente_presupuesto (el campo no existe en la lista)' }]);
    expect(posts().map((p) => p.ruta.split('/')[4])).toEqual(['f-cat', 'f-pres', 'f-pond', 'f-indice', 'f-desg']);
  });

  it('sin el campo opcional «Índice de orden» se escribe igual (5 campos) y se anota, sin tocar otro campo en su lugar', async () => {
    falso.campos = falso.campos.filter((c) => c.name !== 'Índice de orden') as typeof falso.campos;
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    const informe = await lote({ escribirMaximo: 5 });
    expect(informe.escrituras).toEqual([{ clickupTaskId: 'l1', nombre: 'Lead 1', resultado: 'escrito', campos: 5, detalle: 'indice_orden (el campo no existe en la lista)' }]);
    expect(posts().map((p) => p.ruta.split('/')[4])).toEqual(['f-cat', 'f-fuente', 'f-pres', 'f-pond', 'f-desg']);
  });

  it('con el tope en 0 (por defecto) no se escribe nada aunque haya leads calificados', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    await lote();
    await lote({ escribirMaximo: 0 });
    expect(posts()).toEqual([]);
  });

  it('si a la lista le falta un campo u opción, no escribe nada de ese lead y lo cuenta como error', async () => {
    falso.campos = falso.campos.filter((c) => c.name !== 'Desglose de calificación') as typeof falso.campos;
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    const informe = await lote({ escribirMaximo: 5 });
    expect(informe.escrituras).toEqual([{ clickupTaskId: 'l1', nombre: 'Lead 1', resultado: 'error', campos: 0, detalle: 'La lista no tiene el campo «Desglose de calificación»' }]);
    expect(posts()).toEqual([]);
    expect(informe.filas[0]).toMatchObject({ estado: 'procesada', categoria: 'A+' });
  });

  it('reintenta si el modelo falla y acaba bien; si falla siempre, queda como fallo del modelo', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    fallos = 1;
    const esperas: number[] = [];
    const primera = await lote({ esperar: async (ms) => { esperas.push(ms); } });
    expect(primera.filas[0]).toMatchObject({ estado: 'procesada', intentos: 2 });
    expect(esperas).toEqual([2000]);
    expect(await contar('lead_criterio_evaluacion')).toBe(7);
    fallos = 99;
    await base.exec('DELETE FROM lead_criterio_evaluacion; DELETE FROM lead_presupuesto_evento; DELETE FROM lead_calificacion_historial');
    esperas.length = 0;
    const segunda = await lote({ esperar: async (ms) => { esperas.push(ms); } });
    // Aunque el modelo falle, la fila dice a qué lead iba la llamada (se vinculó antes de llamar al modelo).
    expect(segunda.filas[0]).toMatchObject({ estado: 'modelo_fallo', intentos: 2, categoria: null, motivo: 'Gemini respondió HTTP 503', lead: { id: 'l1', nombre: 'Lead 1' } });
    expect(esperas).toEqual([2000]);
    expect(segunda.escrituras).toEqual([]);
    expect(segunda.resumen.leadsCalificados).toBe(0);
  });

  it('una respuesta que no es JSON también se reintenta; si sigue mal, queda como salida inválida con su lead', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    respuestasMalas = 1;
    expect((await lote()).filas[0]).toMatchObject({ estado: 'procesada', intentos: 2 });
    await base.exec('DELETE FROM lead_criterio_evaluacion; DELETE FROM lead_presupuesto_evento; DELETE FROM lead_calificacion_historial');
    respuestasMalas = 99;
    const informe = await lote();
    expect(informe.filas[0]).toMatchObject({ estado: 'salida_invalida', intentos: 2, motivo: 'la respuesta no es JSON', lead: { id: 'l1', nombre: 'Lead 1' }, categoria: null });
    expect(informe.resumen.leadsCalificados).toBe(0);
  });

  it('un fallo de la base se reintenta como cualquier otro: a la segunda sale bien', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: '+34600000001' });
    let primera = true;
    const informe = await lote({
      evaluar: async (s, u) => {
        if (primera) {
          primera = false;
          await base.exec('ALTER TABLE lead_no_apto_evento RENAME TO lead_no_apto_evento_roto');
        } else await base.exec('ALTER TABLE lead_no_apto_evento_roto RENAME TO lead_no_apto_evento');
        return evaluar(s, u);
      },
    });
    expect(informe.filas[0]).toMatchObject({ estado: 'procesada', intentos: 2, categoria: 'A+' });
  });

  it('la fila refleja lo que el código descartó y lo que queda para revisión manual', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    const id = await llamada({ id: 'u1', telefono: '+34600000001' });
    guiones.set(id, { citaDecisor: 'Decide mi suegra por todos nosotros siempre', noAptoInventado: true });
    const [fila] = (await lote()).filas;
    expect(fila!.descartes).toBeGreaterThan(0);
    expect(fila!.desglose).toContain('Dec NE');
    expect(fila!.revisionManual).toEqual(['presupuesto insuficiente sin solución señalado sin una cita verificable']);
    expect(fila!.citas.map((c) => c.criterio)).toEqual(['presupuesto', 'urgencia']);
  });

  it('una llamada con número oculto no tiene con qué vincularse: Netelip no da el email, solo el teléfono', async () => {
    tareas({ id: 'c', nombre: 'Carlos', email: 'Carlos@Example.com', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u1', telefono: null });
    expect((await lote()).filas[0]).toMatchObject({ estado: 'sin_lead', motivo: 'sin_datos', via: null });
  });

  it('informa del progreso: leads, vivos, llamadas y un aviso cada 10 llamadas', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    for (let i = 0; i < 10; i += 1) await llamada({ id: `u${i}`, telefono: '+34600000001', ocurrida: `2026-11-0${2 + (i % 8)}T1${i % 10}:00:00Z` });
    const mensajes: string[] = [];
    await lote({ registro: (m) => mensajes.push(m) });
    expect(mensajes).toEqual(['ClickUp: 1 leads, 1 vivos', 'Llamadas con transcripción en la ventana: 10', '  10/10 llamadas']);
  });

  it('un fallo inesperado de la base en una llamada no tumba el lote: queda como error y sigue con las demás', async () => {
    tareas(
      { id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'l2', nombre: 'Lead 2', telefono: '+34600000002', etapa: ETAPA.viabilidad },
    );
    await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-02T10:00:00Z' });
    await llamada({ id: 'u2', telefono: '+34600000002', ocurrida: '2026-11-03T10:00:00Z' });
    let primera = true;
    const informe = await lote({
      evaluar: async (s, u) => {
        if (primera) {
          primera = false;
          await base.exec('ALTER TABLE lead_no_apto_evento RENAME TO lead_no_apto_evento_roto');
        } else await base.exec('ALTER TABLE IF EXISTS lead_no_apto_evento_roto RENAME TO lead_no_apto_evento');
        return evaluar(s, u);
      },
      intentos: 1,
    });
    expect(informe.filas.map((f) => f.estado)).toEqual(['error', 'procesada']);
    expect(informe.filas[0]!.motivo).toContain('lead_no_apto_evento');
    expect(informe.resumen.porEstado).toEqual({ error: 1, procesada: 1 });
  });

  it('el nivel provisional de Alcance del formulario se deja una sola vez por lead vivo; repetir el lote no duplica', async () => {
    tareas(
      { id: 'a', nombre: 'A', telefono: '+34600000001', etapa: ETAPA.viabilidad, tipoContacto: 0 },
      { id: 'b', nombre: 'B', telefono: '+34600000002', etapa: ETAPA.visita, tipoContacto: 1 },
      { id: 'c', nombre: 'C', telefono: '+34600000003', etapa: ETAPA.en_espera, tipoContacto: 2 },
      { id: 'd', nombre: 'D', telefono: '+34600000004', etapa: ETAPA.rechazado, tipoContacto: 0 },
      { id: 'e', nombre: 'E', telefono: '+34600000005', etapa: ETAPA.viabilidad, cerrada: true, tipoContacto: 0 },
    );
    const primera = await lote();
    expect(primera.resumen).toMatchObject({ leadsEnLista: 5, leadsVivos: 3, alcanceProvisional: 2 });
    const filas = await base.query<{ clickup_task_id: string; nivel: string }>("SELECT clickup_task_id, nivel FROM lead_criterio_evaluacion WHERE origen = 'formulario_provisional' ORDER BY 1");
    expect(filas.rows).toEqual([{ clickup_task_id: 'a', nivel: 'A' }, { clickup_task_id: 'b', nivel: 'C' }]);
    // La fecha del nivel provisional es la de creación de la tarea (1762000000000 ms), no la del proceso.
    const fechas = await base.query<{ f: string }>("SELECT DISTINCT to_char(fecha_interaccion AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS f FROM lead_criterio_evaluacion");
    expect(fechas.rows).toEqual([{ f: '2025-11-01' }]);
    expect((await lote()).resumen.alcanceProvisional).toBe(0);
    expect(await contar('lead_criterio_evaluacion')).toBe(2);
  });

  it('si el formulario trae tipo_reforma y tipo de contacto, manda el tipo de reforma', async () => {
    // tipo_reforma «Integral» (A) frente a un tipo de contacto «global» (C): gana el primero.
    tareas({ id: 'a', nombre: 'A', telefono: '+34600000001', etapa: ETAPA.viabilidad, tipoReforma: 0, tipoContacto: 1 });
    await lote();
    const r = await base.query<{ nivel: string }>("SELECT nivel FROM lead_criterio_evaluacion WHERE clickup_task_id = 'a'");
    expect(r.rows).toEqual([{ nivel: 'A' }]);
  });

  it('las llamadas se procesan por fecha: la letra final es la de la última llamada', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    // Insertada primero la más reciente: el orden de la ventana manda, no el de llegada.
    const reciente = await llamada({ id: 'u2', telefono: '+34600000001', ocurrida: '2026-11-09T10:00:00Z' });
    const antigua = await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-04T10:00:00Z' });
    guiones.set(antigua, { nivelDecisor: 'D', plazoMeses: 14 });
    guiones.set(reciente, { nivelDecisor: 'A', plazoMeses: 2 });
    const informe = await lote();
    expect(informe.filas.map((f) => f.llamadaId)).toEqual([antigua, reciente]);
    expect(informe.filas[0]!.desglose).toContain('Dec D');
    expect(informe.filas[1]!.desglose).toContain('Dec A');
    expect(informe.filas[1]!.desglose).toContain('Urg A');
  });

  it('el límite corta la lista de llamadas y la ventana excluye la fecha final', async () => {
    tareas({ id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad });
    await llamada({ id: 'u0', telefono: '+34600000001', ocurrida: '2026-11-01T00:00:00Z' });
    await llamada({ id: 'u1', telefono: '+34600000001', ocurrida: '2026-11-02T10:00:00Z' });
    await llamada({ id: 'u2', telefono: '+34600000001', ocurrida: '2026-11-03T10:00:00Z' });
    await llamada({ id: 'u3', telefono: '+34600000001', ocurrida: '2026-11-13T00:00:00Z' });
    expect((await lote({ limite: 1 })).filas).toHaveLength(1);
    // Entran la del instante inicial exacto y las de dentro; queda fuera la del instante final exacto.
    expect((await lote()).filas).toHaveLength(3);
  });

  it('solo se procesan tareas padre de la lista: una subtarea con el mismo teléfono no cuenta', async () => {
    tareas(
      { id: 'l1', nombre: 'Lead 1', telefono: '+34600000001', etapa: ETAPA.viabilidad },
      { id: 'sub', nombre: 'Subtarea', telefono: '+34600000001', etapa: ETAPA.viabilidad, padre: 'l1' },
    );
    await llamada({ id: 'u1', telefono: '+34600000001' });
    const informe = await lote();
    expect(falso.peticiones.find((p) => p.ruta.includes('/task?'))?.ruta).toContain('subtasks=false');
    expect(informe.filas[0]).toMatchObject({ estado: 'procesada', lead: { id: 'l1' } });
    expect(informe.resumen).toMatchObject({ leadsEnLista: 1, leadsVivos: 1 });
  });
});
