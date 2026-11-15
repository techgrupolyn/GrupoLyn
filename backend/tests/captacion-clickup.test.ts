// Cliente de ClickUp de la captación ABCD contra un servidor HTTP falso local (con el `fetch` real: se
// comprueban la cabecera de autorización, las rutas y los cuerpos). Nunca llama al ClickUp de verdad.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aLeadCandidato, ClickUpClient, clickupConfigDesdeEnv, ClickUpConfigError, ClickUpError, ClickUpEscrituraParcial, ESCALA_ORDEN, escribirPlan, indiceOrdenDe, NOMBRES_CAMPOS, planEscritura,
  RANGO_ORDEN, type CampoLista,
} from '../netelip/captacion/clickup.ts';
import { CAMPOS_PERMITIDOS, CATEGORIAS, ETIQUETA_SIN_PRESUPUESTO } from '../netelip/captacion/tipos.ts';

const TOKEN = 'pk_token_de_prueba_123';
const LISTA = '901211441576';

interface Peticion { metodo: string; ruta: string; auth: string | undefined; tipo: string | undefined; cuerpo: unknown }

const CAMPOS_FALSOS = [
  { id: 'f-cat', name: 'valoracion_interna', type: 'drop_down', type_config: { options: ['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto'].map((name, i) => ({ id: `o-cat-${i}`, name, orderindex: i })) } },
  { id: 'f-pres', name: 'presupuesto_estimado', type: 'currency', type_config: {} },
  { id: 'f-pond', name: 'valor_del_negocio', type: 'currency', type_config: {} },
  { id: 'f-fuente', name: 'Fuente del presupuesto', type: 'drop_down', type_config: { options: ['Formulario', 'Llamada', 'Reunión', 'WhatsApp', 'Fase 2 LYN', 'Manual', ETIQUETA_SIN_PRESUPUESTO].map((name, i) => ({ id: `o-fuente-${i}`, name, orderindex: i })) } },
  { id: 'f-desg', name: 'Desglose de calificación', type: 'short_text', type_config: {} },
  { id: 'f-tel', name: 'contact_phone_number', type: 'phone', type_config: {} },
  { id: 'f-mail', name: 'email', type: 'email', type_config: {} },
  { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: { options: [{ id: 'o-e3', name: 'e3_VIABILIDAD', orderindex: 3 }] } },
  // Al final: arriba se usa CAMPOS_FALSOS[7] (ETAPA_CRM) por posición.
  { id: 'f-indice', name: 'Índice de orden', type: 'number', type_config: {} },
];

let servidor: Server;
let base: string;
let peticiones: Peticion[];
/** Cada prueba programa cómo responde el servidor falso. */
let manejador: (req: IncomingMessage, res: ServerResponse, p: Peticion) => void;

const json = (res: ServerResponse, estado: number, cuerpo: unknown, cabeceras: Record<string, string> = {}) => {
  res.writeHead(estado, { 'content-type': 'application/json', ...cabeceras });
  res.end(JSON.stringify(cuerpo));
};

beforeEach(async () => {
  peticiones = [];
  manejador = (_req, res) => json(res, 200, {});
  servidor = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on('data', (t) => trozos.push(t));
    req.on('end', () => {
      const texto = Buffer.concat(trozos).toString('utf8');
      const p: Peticion = { metodo: req.method ?? '', ruta: req.url ?? '', auth: req.headers.authorization, tipo: req.headers['content-type'], cuerpo: texto ? JSON.parse(texto) : undefined };
      peticiones.push(p);
      manejador(req, res, p);
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((ok) => servidor.close(() => ok()));
});

const esperas: number[] = [];
const cliente = (extra: Partial<ConstructorParameters<typeof ClickUpClient>[0]> = {}) => {
  esperas.length = 0;
  return new ClickUpClient({ token: TOKEN, listaId: LISTA, baseUrl: base, pausaMs: 0, esperar: async (ms) => { esperas.push(ms); }, ...extra });
};

describe('ClickUp · lectura', () => {
  it('lista los campos con sus opciones y manda el token tal cual en Authorization', async () => {
    manejador = (_q, res) => json(res, 200, { fields: CAMPOS_FALSOS });
    const campos = await cliente().campos();
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0]).toMatchObject({ metodo: 'GET', ruta: `/list/${LISTA}/field`, auth: TOKEN });
    const cat = campos.find((c) => c.name === 'valoracion_interna');
    expect(cat?.opciones.map((o) => o.name)).toEqual(['A+', 'A', 'B', 'C', 'D', 'Sin calificar', 'No apto']);
    expect(campos.find((c) => c.name === 'email')?.opciones).toEqual([]);
  });

  it('recorre todas las páginas (100 + 50), traduce los desplegables y distingue padre, cerrada y moneda', async () => {
    const tarea = (n: number) => ({
      id: `t${n}`, name: `Lead ${n}`, status: { status: n === 3 ? 'perdido' : 'en curso', type: n === 3 ? 'closed' : 'open' }, date_created: '1762000000000',
      ...(n === 4 ? { parent: 'padre-1' } : {}),
      custom_fields: [
        { id: 'f-etapa', name: 'ETAPA_CRM', type: 'drop_down', type_config: CAMPOS_FALSOS[7]?.type_config, value: 3 },
        { id: 'f-pres', name: 'presupuesto_estimado', type: 'currency', type_config: {}, value: '120000' },
        { id: 'f-tel', name: 'contact_phone_number', type: 'phone', type_config: {}, value: '+34 600 111 222' },
        { id: 'f-mail', name: 'email', type: 'email', type_config: {}, value: '' },
      ],
    });
    manejador = (_q, res, p) => {
      const pagina = Number(new URL(p.ruta, 'http://x').searchParams.get('page'));
      json(res, 200, { tasks: Array.from({ length: pagina === 0 ? 100 : 50 }, (_, i) => tarea(pagina * 100 + i)) });
    };
    const todas = [];
    for await (const t of cliente().tareas()) todas.push(t);
    expect(todas).toHaveLength(150);
    expect(peticiones.map((p) => new URL(p.ruta, 'http://x').searchParams.get('page'))).toEqual(['0', '1']);
    expect(peticiones[0]?.ruta).toContain('subtasks=false');
    expect(todas[3]).toMatchObject({ id: 't3', nombre: 'Lead 3', cerrada: true, estado: 'perdido', esPadre: true, creadaEn: 1762000000000 });
    expect(todas[4]).toMatchObject({ id: 't4', esPadre: false });
    expect(todas[0]?.campos).toEqual({ ETAPA_CRM: 'e3_VIABILIDAD', presupuesto_estimado: 120000, contact_phone_number: '+34 600 111 222', email: null });
    expect(aLeadCandidato(todas[0]!)).toEqual({ clickupTaskId: 't0', esTareaPadre: true, telefono: '+34 600 111 222', email: null });
    expect(aLeadCandidato(todas[4]!).esTareaPadre).toBe(false);
  });

  it('una página de exactamente 100 pide la siguiente y una vacía termina', async () => {
    manejador = (_q, res, p) => {
      const pagina = Number(new URL(p.ruta, 'http://x').searchParams.get('page'));
      json(res, 200, { tasks: pagina === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: 'x', status: {}, custom_fields: [] })) : [] });
    };
    const n: string[] = [];
    for await (const t of cliente().tareas()) n.push(t.id);
    expect(n).toHaveLength(100);
    expect(peticiones).toHaveLength(2);
  });

  it('lee una tarea concreta y rechaza ids con caracteres de ruta', async () => {
    manejador = (_q, res) => json(res, 200, { id: 'abc123', name: 'Uno', status: { status: 'x', type: 'open' }, custom_fields: [] });
    expect((await cliente().tarea('abc123')).id).toBe('abc123');
    expect(peticiones[0]?.ruta).toBe('/task/abc123');
    await expect(cliente().tarea('../list/1')).rejects.toThrow('Id de tarea no válido');
    expect(peticiones).toHaveLength(1);
  });
});

describe('ClickUp · escritura', () => {
  const campos: CampoLista[] = CAMPOS_FALSOS.map((f) => ({ id: f.id, name: f.name, type: f.type, opciones: (f.type_config as { options?: Array<{ id: string; name: string; orderindex: number }> }).options ?? [] }));

  it('traduce las escrituras del motor: opción por nombre, importes tal cual y el desglose', () => {
    const plan = planEscritura({ categoria: 'A+', presupuesto: 120000, ponderado: 120000, fuente_presupuesto: 'Llamada', desglose: 'Pres A · … · 3,60 · cob. 100 %' }, campos);
    expect(plan.cambios).toEqual([
      { clave: 'categoria', campoId: 'f-cat', valor: 'o-cat-0' },
      { clave: 'fuente_presupuesto', campoId: 'f-fuente', valor: 'o-fuente-1' },
      { clave: 'presupuesto', campoId: 'f-pres', valor: 120000 },
      { clave: 'ponderado', campoId: 'f-pond', valor: 120000 },
      { clave: 'indice_orden', campoId: 'f-indice', valor: 600_120_000 },
      { clave: 'desglose', campoId: 'f-desg', valor: 'Pres A · … · 3,60 · cob. 100 %' },
    ]);
    expect(plan.omitidos).toEqual([]);
  });

  it('sin presupuesto ni ponderado no se escriben (se anotan como omitidos) y «sin calificar» usa su etiqueta', () => {
    const plan = planEscritura({ categoria: 'sin_calificar', presupuesto: null, ponderado: null, fuente_presupuesto: ETIQUETA_SIN_PRESUPUESTO }, campos);
    expect(plan.cambios.map((c) => [c.clave, c.valor])).toEqual([['categoria', 'o-cat-5'], ['fuente_presupuesto', 'o-fuente-6'], ['indice_orden', 100_000_000]]);
    expect(plan.omitidos).toEqual(['presupuesto (sin valor)', 'ponderado (sin valor)']);
  });

  it('un 0 de ponderado (No apto) sí se escribe: es un valor, no una ausencia', () => {
    const plan = planEscritura({ categoria: 'no_apto', presupuesto: 30000, ponderado: 0, fuente_presupuesto: 'Llamada' }, campos);
    expect(plan.cambios.find((c) => c.clave === 'ponderado')?.valor).toBe(0);
  });

  it('sin el campo o sin la opción lanza ClickUpConfigError y no devuelve ningún cambio', () => {
    const sinDesglose = campos.filter((c) => c.name !== NOMBRES_CAMPOS.desglose);
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1, ponderado: 1, fuente_presupuesto: 'Llamada', desglose: 'x' }, sinDesglose)).toThrow(ClickUpConfigError);
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1, ponderado: 1, fuente_presupuesto: 'Llamada' }, sinDesglose)).not.toThrow();
    const catVieja = campos.map((c) => (c.name === 'valoracion_interna' ? { ...c, opciones: c.opciones.filter((o) => o.name !== 'A+') } : c));
    expect(() => planEscritura({ categoria: 'A+', presupuesto: 1, ponderado: 1, fuente_presupuesto: 'Llamada' }, catVieja)).toThrow(/valoracion_interna.*A\+/);
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1, ponderado: 1, fuente_presupuesto: 'Llamada' }, catVieja)).not.toThrow();
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1, ponderado: 1, fuente_presupuesto: 'Telepatía' }, campos)).toThrow(/Fuente del presupuesto.*Telepatía/);
    expect(() => planEscritura({ categoria: 'A', presupuesto: Number.NaN, ponderado: 1, fuente_presupuesto: 'Llamada' }, campos)).toThrow(/presupuesto no es un número/);
  });

  it('escribe campo a campo: POST /task/{id}/field/{campo} con {value}', async () => {
    const plan = planEscritura({ categoria: 'B', presupuesto: 80000, ponderado: 60000, fuente_presupuesto: 'Formulario', desglose: 'd' }, campos);
    expect(await escribirPlan(cliente(), 'tarea9', plan)).toBe(6);
    expect(peticiones.map((p) => [p.metodo, p.ruta, p.cuerpo, p.auth])).toEqual([
      ['POST', '/task/tarea9/field/f-cat', { value: 'o-cat-2' }, TOKEN],
      ['POST', '/task/tarea9/field/f-fuente', { value: 'o-fuente-0' }, TOKEN],
      ['POST', '/task/tarea9/field/f-pres', { value: 80000 }, TOKEN],
      ['POST', '/task/tarea9/field/f-pond', { value: 60000 }, TOKEN],
      ['POST', '/task/tarea9/field/f-indice', { value: 400_060_000 }, TOKEN],
      ['POST', '/task/tarea9/field/f-desg', { value: 'd' }, TOKEN],
    ]);
    expect(peticiones.every((p) => p.tipo === 'application/json')).toBe(true);
  });

  it('«Fuente del presupuesto» es OPCIONAL: sin el campo se omite y se anota; con el campo pero sin la opción es un error', () => {
    const sinFuente = campos.filter((c) => c.name !== 'Fuente del presupuesto');
    const plan = planEscritura({ categoria: 'A', presupuesto: 1000, ponderado: 1000, fuente_presupuesto: 'Llamada', desglose: 'd' }, sinFuente);
    expect(plan.cambios.map((c) => c.clave)).toEqual(['categoria', 'presupuesto', 'ponderado', 'indice_orden', 'desglose']);
    expect(plan.omitidos).toEqual(['fuente_presupuesto (el campo no existe en la lista)']);
    const sinOpcion = campos.map((c) => (c.name === 'Fuente del presupuesto' ? { ...c, opciones: c.opciones.filter((o) => o.name !== 'Llamada') } : c));
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1000, ponderado: 1000, fuente_presupuesto: 'Llamada' }, sinOpcion)).toThrow(ClickUpConfigError);
    // Los demás campos siguen siendo obligatorios.
    expect(() => planEscritura({ categoria: 'A', presupuesto: 1000, ponderado: 1000, fuente_presupuesto: 'Llamada' }, sinFuente.filter((c) => c.name !== 'valor_del_negocio'))).toThrow(ClickUpConfigError);
  });

  it('sin fuente informada usa «Pendiente: preguntar en la 1ª llamada»', () => {
    const plan = planEscritura({ categoria: 'sin_calificar', presupuesto: null, ponderado: null, fuente_presupuesto: '' }, campos);
    expect(plan.cambios.find((c) => c.clave === 'fuente_presupuesto')?.valor).toBe('o-fuente-6');
  });

  it('si falla un campo DESPUÉS de haber escrito otros, lanza escritura parcial con los campos escritos y no sigue', async () => {
    manejador = (_q, res, p) => (p.ruta.endsWith('/f-pres') ? json(res, 404, {}) : json(res, 200, {}));
    const plan = planEscritura({ categoria: 'B', presupuesto: 80000, ponderado: 60000, fuente_presupuesto: 'Formulario', desglose: 'd' }, campos);
    const e = (await escribirPlan(cliente(), 't1', plan).catch((x) => x)) as ClickUpEscrituraParcial;
    expect(e).toBeInstanceOf(ClickUpEscrituraParcial);
    expect(e).toMatchObject({ camposEscritos: 2, camposTotal: 6 });
    expect(e.message).toBe('escritura parcial: 2 de 6 campos (ClickUp respondió 404 en POST /task/t1/field/f-pres)');
    expect(e.causa).toBeInstanceOf(ClickUpError);
    expect(e.message).not.toContain(TOKEN);
    expect(peticiones.map((p) => p.ruta)).toEqual(['/task/t1/field/f-cat', '/task/t1/field/f-fuente', '/task/t1/field/f-pres']);
  });

  it('si falla el PRIMER campo no se tocó nada: el error es el de ClickUp, no una escritura parcial', async () => {
    manejador = (_q, res) => json(res, 404, {});
    const plan = planEscritura({ categoria: 'B', presupuesto: 80000, ponderado: 60000, fuente_presupuesto: 'Formulario' }, campos);
    const e = (await escribirPlan(cliente(), 't1', plan).catch((x) => x)) as ClickUpError;
    expect(e).toBeInstanceOf(ClickUpError);
    expect(e).not.toBeInstanceOf(ClickUpEscrituraParcial);
    expect(e.estado).toBe(404);
    expect(peticiones).toHaveLength(1);
  });

  it('solo se escribe en los campos del plan: nada de etapa, estado ni título', async () => {
    const plan = planEscritura({ categoria: 'C', presupuesto: null, ponderado: null, fuente_presupuesto: ETIQUETA_SIN_PRESUPUESTO }, campos);
    await escribirPlan(cliente(), 't1', plan);
    expect(peticiones.every((p) => p.metodo === 'POST' && /^\/task\/t1\/field\/f-(cat|fuente|indice)$/.test(p.ruta))).toBe(true);
    expect(peticiones.some((p) => p.ruta.includes('f-etapa') || p.ruta === '/task/t1')).toBe(false);
  });

  it('rechaza ids de tarea o de campo con caracteres de ruta antes de llamar', async () => {
    await expect(cliente().escribirCampo('../x', 'f-cat', 'a')).rejects.toThrow('Id de tarea no válido');
    await expect(cliente().escribirCampo('t1', 'f-cat/../x', 'a')).rejects.toThrow('Id de campo no válido');
    expect(peticiones).toHaveLength(0);
  });
});

describe('ClickUp · índice de orden del tablero', () => {
  const campos: CampoLista[] = CAMPOS_FALSOS.map((f) => ({ id: f.id, name: f.name, type: f.type, opciones: (f.type_config as { options?: Array<{ id: string; name: string; orderindex: number }> }).options ?? [] }));

  it('cada categoría tiene su rango, de A+ (6) a No apto (0), sin repetirse', () => {
    expect(RANGO_ORDEN).toEqual({ 'A+': 6, A: 5, B: 4, C: 3, D: 2, sin_calificar: 1, no_apto: 0 });
    expect(Object.keys(RANGO_ORDEN).sort()).toEqual([...CATEGORIAS].sort());
    expect(new Set(Object.values(RANGO_ORDEN)).size).toBe(CATEGORIAS.length);
  });

  it('el índice es rango x 100.000.000 más el ponderado en euros', () => {
    expect(ESCALA_ORDEN).toBe(100_000_000);
    expect(indiceOrdenDe('A+', 120_000)).toBe(600_120_000);
    expect(indiceOrdenDe('A', 55_000)).toBe(500_055_000);
    expect(indiceOrdenDe('B', 60_000)).toBe(400_060_000);
    expect(indiceOrdenDe('C', 1)).toBe(300_000_001);
    expect(indiceOrdenDe('D', 10_000)).toBe(200_010_000);
    expect(indiceOrdenDe('sin_calificar', null)).toBe(100_000_000);
    expect(indiceOrdenDe('no_apto', 0)).toBe(0);
  });

  it('ordenado de mayor a menor sale A+, A, B, C, D, sin calificar, no apto; y dentro de cada letra, el de más valor primero', () => {
    const leads = [
      { id: 'noapto', c: 'no_apto' as const, p: 0 },
      { id: 'b-bajo', c: 'B' as const, p: 5_000 },
      { id: 'a-plus-poco', c: 'A+' as const, p: 100_000 },
      { id: 'a-mucho', c: 'A' as const, p: 9_999_999 },
      { id: 'sin', c: 'sin_calificar' as const, p: null },
      { id: 'd', c: 'D' as const, p: 800_000 },
      { id: 'b-alto', c: 'B' as const, p: 400_000 },
      { id: 'c', c: 'C' as const, p: 20_000 },
      { id: 'a-sin-importe', c: 'A' as const, p: null },
      { id: 'a-mediano', c: 'A' as const, p: 70_000 },
    ];
    const orden = [...leads].sort((x, y) => indiceOrdenDe(y.c, y.p) - indiceOrdenDe(x.c, x.p)).map((l) => l.id);
    expect(orden).toEqual(['a-plus-poco', 'a-mucho', 'a-mediano', 'a-sin-importe', 'b-alto', 'b-bajo', 'c', 'd', 'sin', 'noapto']);
  });

  it('un importe enorme no salta a la categoría de arriba (tope), y uno raro cuenta como 0', () => {
    expect(indiceOrdenDe('B', 1e12)).toBe(499_999_999);
    expect(indiceOrdenDe('B', 1e12)).toBeLessThan(indiceOrdenDe('A', 0));
    expect(indiceOrdenDe('A+', Number.MAX_SAFE_INTEGER)).toBeLessThan(7 * ESCALA_ORDEN);
    for (const raro of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
      expect(indiceOrdenDe('A', raro)).toBe(500_000_000);
    }
    expect(indiceOrdenDe('A', 1234.6)).toBe(500_001_235);
    expect(Number.isSafeInteger(indiceOrdenDe('A+', 5_000_000))).toBe(true);
  });

  it('el plan escribe el índice de la categoría y el ponderado que ve ClickUp, en el campo «Índice de orden»', () => {
    const plan = planEscritura({ categoria: 'B', presupuesto: 80000, ponderado: 60000, fuente_presupuesto: 'Formulario', desglose: 'd' }, campos);
    expect(plan.cambios.find((c) => c.clave === 'indice_orden')).toEqual({ clave: 'indice_orden', campoId: 'f-indice', valor: 400_060_000 });
    expect(NOMBRES_CAMPOS.indice_orden).toBe('Índice de orden');
  });

  it('el campo es OPCIONAL: sin él se escribe todo lo demás y se anota; no se confunde con otro campo', () => {
    const sinIndice = campos.filter((c) => c.name !== 'Índice de orden');
    const plan = planEscritura({ categoria: 'A', presupuesto: 1000, ponderado: 1000, fuente_presupuesto: 'Llamada', desglose: 'd' }, sinIndice);
    expect(plan.cambios.map((c) => c.clave)).toEqual(['categoria', 'fuente_presupuesto', 'presupuesto', 'ponderado', 'desglose']);
    expect(plan.omitidos).toEqual(['indice_orden (el campo no existe en la lista)']);
  });

  it('solo se escribe en campos permitidos del sistema (el índice está entre ellos)', () => {
    const plan = planEscritura({ categoria: 'A+', presupuesto: 150000, ponderado: 150000, fuente_presupuesto: 'Formulario', desglose: 'd' }, campos);
    const permitidos: readonly string[] = CAMPOS_PERMITIDOS;
    expect(plan.cambios.every((c) => permitidos.includes(c.clave))).toBe(true);
    expect(permitidos).toContain('indice_orden');
  });

  it('un No apto queda siempre por debajo de un sin calificar, y este por debajo de un D, aunque el importe sea grande', () => {
    expect(indiceOrdenDe('no_apto', 5_000_000)).toBeLessThan(indiceOrdenDe('sin_calificar', null));
    expect(indiceOrdenDe('sin_calificar', 50_000_000)).toBeLessThan(indiceOrdenDe('D', null));
    expect(indiceOrdenDe('D', 99_999_999)).toBeLessThan(indiceOrdenDe('C', null));
  });
});

describe('ClickUp · límites y fallos', () => {
  it('429: espera hasta el reinicio del límite y reintenta', async () => {
    let veces = 0;
    manejador = (_q, res) => {
      veces += 1;
      if (veces === 1) json(res, 429, { err: 'limit' }, { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 30) });
      else json(res, 200, { fields: [] });
    };
    await cliente().campos();
    expect(peticiones).toHaveLength(2);
    expect(esperas.some((e) => e > 20_000 && e <= 31_000)).toBe(true);
  });

  it('429 con el reinicio dentro de una hora: la espera no pasa de 60 s', async () => {
    let veces = 0;
    manejador = (_q, res) => (++veces === 1 ? json(res, 429, {}, { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600) }) : json(res, 200, { fields: [] }));
    await cliente().campos();
    expect(esperas).toEqual([60_000]);
  });

  it('5xx transitorio: reintenta con espera creciente y acaba bien', async () => {
    let veces = 0;
    manejador = (_q, res) => (++veces < 3 ? json(res, 503, {}) : json(res, 200, { fields: [] }));
    await cliente().campos();
    expect(peticiones).toHaveLength(3);
    expect(esperas).toEqual([2000, 4000]);
  });

  it('5xx permanente: tras 5 intentos lanza ClickUpError reintentable, sin el token ni el cuerpo', async () => {
    manejador = (_q, res) => json(res, 500, { err: 'detalle con datos de un cliente 600111222' });
    const e = (await cliente().campos().catch((x) => x)) as ClickUpError;
    expect(e).toBeInstanceOf(ClickUpError);
    expect(peticiones).toHaveLength(5);
    expect(e).toMatchObject({ estado: 500, reintentable: true });
    expect(e.message).toBe(`ClickUp respondió 500 en GET /list/${LISTA}/field`);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain('600111222');
  });

  it('401 y 404 no se reintentan: un solo intento y error no reintentable', async () => {
    manejador = (_q, res) => json(res, 401, { err: 'Token invalid' });
    const a = (await cliente().campos().catch((x) => x)) as ClickUpError;
    expect(peticiones).toHaveLength(1);
    expect(a).toMatchObject({ estado: 401, reintentable: false });
    manejador = (_q, res) => json(res, 404, {});
    const b = (await cliente().escribirCampo('t1', 'f-cat', 'x').catch((x) => x)) as ClickUpError;
    expect(b).toMatchObject({ estado: 404, reintentable: false });
    expect(peticiones).toHaveLength(2);
  });

  it('sin respuesta del servidor: reintenta y acaba con un error sin el texto de la causa', async () => {
    await new Promise<void>((ok) => servidor.close(() => ok()));
    const e = (await cliente({ baseUrl: base }).campos().catch((x) => x)) as ClickUpError;
    expect(e).toBeInstanceOf(ClickUpError);
    expect(e).toMatchObject({ estado: null, reintentable: true });
    expect(e.message).toBe('sin respuesta de ClickUp: TypeError');
    expect(esperas).toEqual([1000, 2000, 4000, 8000]);
    expect(e.message).not.toContain(TOKEN);
    servidor = createServer();
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  });

  it('respeta la pausa mínima entre peticiones (límite de 100 por minuto)', async () => {
    manejador = (_q, res) => json(res, 200, { fields: [] });
    const c = new ClickUpClient({ token: TOKEN, listaId: LISTA, baseUrl: base, pausaMs: 700, esperar: async (ms) => { esperas.push(ms); } });
    esperas.length = 0;
    await c.campos();
    await c.campos();
    await c.campos();
    expect(esperas.length).toBeGreaterThanOrEqual(2);
    expect(esperas.every((e) => e > 0 && e <= 700)).toBe(true);
  });

  it('configuración: token obligatorio y lista numérica', () => {
    expect(() => new ClickUpClient({ token: '', listaId: LISTA })).toThrow('Falta el token');
    expect(() => new ClickUpClient({ token: TOKEN, listaId: 'abc/../' })).toThrow('numérico');
  });

  it('desde el entorno: necesita el token y la lista; sin cualquiera de los dos queda apagado (null)', () => {
    expect(clickupConfigDesdeEnv({ CLICKUP_API_TOKEN: ` ${TOKEN} `, CAPTACION_CLICKUP_LIST_ID: ` ${LISTA} ` })).toEqual({ token: TOKEN, listaId: LISTA });
    expect(clickupConfigDesdeEnv({ CLICKUP_API_TOKEN: TOKEN })).toBeNull();
    expect(clickupConfigDesdeEnv({ CAPTACION_CLICKUP_LIST_ID: LISTA })).toBeNull();
    expect(clickupConfigDesdeEnv({ CLICKUP_API_TOKEN: '  ', CAPTACION_CLICKUP_LIST_ID: LISTA })).toBeNull();
    expect(clickupConfigDesdeEnv({})).toBeNull();
  });
});
