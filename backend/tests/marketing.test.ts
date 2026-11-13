// Panel de marketing (869fny1et): ventanas, atribución, carga de Windsor y ClickUp, árbol sin doble
// conteo y permisos de la API. Sin base de datos real ni llamadas externas.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { canalDelLead, familiaDeAnuncio, normalizarLetra, zonaDeCampana } from '../marketing/atribucion.ts';
import { fuentesPendientesHoy, rangoGasto } from '../marketing/carga.ts';
import { guardarLeads, leadDesdeTarea, leerLeads, valorCampo } from '../marketing/clickup.ts';
import { construirArbol, construirNotas, type FilaGastoPanel, type FilaLeadPanel } from '../marketing/panel.ts';
import { calcularPeriodos, diaMadrid } from '../marketing/periodos.ts';
import { registerMarketing } from '../marketing/routes.ts';
import { filaDesdeWindsor, leerWindsor } from '../marketing/windsor.ts';

const ZONAS = [{ patron: 'alicante', valor: 'Alicante', prioridad: 100 }, { patron: 'murcia', valor: 'Murcia', prioridad: 100 }, { patron: 'sureste', valor: 'Sureste', prioridad: 100 }];
const FAMILIAS = [{ patron: 'cocina', valor: 'Reformas de cocinas', prioridad: 60 }, { patron: 'reel', valor: 'Reels', prioridad: 90 }];
const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe('Marketing · ventanas temporales', () => {
  it('martes 17 de noviembre: meses de mayo a octubre y las 4 semanas anteriores a la semana en curso', () => {
    const { corte, periodos } = calcularPeriodos(new Date('2026-11-17T10:00:00Z'));
    expect(corte).toBe('2026-11-17');
    expect(periodos.filter((p) => p.bloque === 0).map((p) => [p.desde, p.hasta])).toEqual([
      ['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31']]);
    const semanas = periodos.filter((p) => p.bloque === 1);
    expect(semanas.map((p) => [p.desde, p.hasta])).toEqual([
      ['2026-10-19', '2026-10-25'], ['2026-10-26', '2026-11-01'], ['2026-11-02', '2026-11-08'], ['2026-11-09', '2026-11-15']]);
    expect(semanas[1]).toMatchObject({ etiqueta: '26–1', sub: 'oct–nov', largo: '26 oct–1 nov 2026' });
    expect(periodos[0]).toMatchObject({ etiqueta: 'May', largo: 'mayo de 2026' });
  });

  it('un lunes, la semana en curso queda fuera; en enero los meses cruzan de año', () => {
    const { periodos } = calcularPeriodos(new Date('2027-01-04T08:00:00Z'));
    expect(periodos[0].desde).toBe('2026-07-01');
    expect(periodos[5].hasta).toBe('2026-12-31');
    expect(periodos[9].hasta).toBe('2027-01-03');
  });

  it('cohorte en hora de Madrid: el 31 de octubre a las 23:30 cuenta en octubre', () => {
    expect(diaMadrid(new Date('2026-10-31T22:30:00Z'))).toBe('2026-10-31');
    expect(diaMadrid(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11-01');
  });
});

describe('Marketing · reglas de atribución', () => {
  it('canal: manda utm_source; si no, el campo canal de ClickUp', () => {
    expect(canalDelLead('meta', '2')).toBe('meta');
    expect(canalDelLead('', '1')).toBe('tally');
    expect(canalDelLead(null, '2')).toBe('google');
    expect(canalDelLead(null, '3.1')).toBe('meta');
    expect(canalDelLead(null, 'Referido')).toBe('otro');
  });

  it('zona: gana la zona que aparece antes en el nombre de la campaña', () => {
    expect(zonaDeCampana('alicante prueba 1 _ FORMULARIO _ MURCIA', ZONAS)).toBe('Alicante');
    expect(zonaDeCampana('murcia prueba 2 _ MURCIA', ZONAS)).toBe('Murcia');
    expect(zonaDeCampana('Campaña Sureste', ZONAS)).toBe('Sureste');
    expect(zonaDeCampana('Marca', ZONAS)).toBe('Sin zona');
  });

  it('familia y letra', () => {
    expect(familiaDeAnuncio('Reel cocina blanca', FAMILIAS)).toBe('Reformas de cocinas');
    expect(familiaDeAnuncio('Estático 4', FAMILIAS)).toBe('Sin familia');
    expect(normalizarLetra('A+')).toBe('A+');
    expect(normalizarLetra('a++ (top)')).toBe('A++');
    expect(normalizarLetra(' b ')).toBe('B');
    expect(normalizarLetra('No apto')).toBe('No apto');
    expect(normalizarLetra('Presupuesto insuficiente')).toBe('No apto');
    expect(normalizarLetra('Alta')).toBeNull();
    expect(normalizarLetra('')).toBeNull();
  });
});

describe('Marketing · Windsor', () => {
  it('suma las filas repetidas y no expone la clave en los errores', async () => {
    const config = { apiKey: 'CLAVE-SECRETA', conectores: [{ canal: 'meta' as const, conector: 'facebook', campos: ['date'] }] };
    let url = '';
    const filas = await leerWindsor(config, config.conectores[0], '2026-10-01', '2026-10-31', (async (u: string) => {
      url = u;
      return jsonRes({ data: [
        { date: '2026-10-02', campaign_id: 'c1', campaign: 'Alicante', adset_id: 's1', adset_name: 'Ren', ad_id: 'a1', ad_name: 'Cocina', spend: '10.5', clicks: 3, impressions: 100, actions_lead: 2 },
        { date: '2026-10-02', campaign_id: 'c1', campaign: 'Alicante', adset_id: 's1', adset_name: 'Ren', ad_id: 'a1', ad_name: 'Cocina', spend: 4.5, clicks: 1, impressions: 50, actions_lead: '1' },
        { date: 'basura', campaign_id: 'c1' },
      ] });
    }) as typeof fetch);
    expect(url).toContain('date_from=2026-10-01');
    expect(filas).toEqual([{ fecha: '2026-10-02', canal: 'meta', campana_id: 'c1', campana: 'Alicante', conjunto_id: 's1', conjunto: 'Ren', anuncio_id: 'a1', anuncio: 'Cocina', gasto: 15, clics: 4, impresiones: 150, leads: 3 }]);
    await expect(leerWindsor(config, config.conectores[0], '2026-10-01', '2026-10-31', (async () => jsonRes({}, 401)) as typeof fetch))
      .rejects.toThrow(/^Windsor facebook respondió 401$/);
  });

  it('Google no tiene conjunto ni anuncio', () => {
    expect(filaDesdeWindsor('google', { date: '2026-10-02', campaign_id: 'g1', campaign: 'Marca', adset_id: 'x', spend: 2 }))
      .toMatchObject({ canal: 'google', conjunto_id: '', anuncio_id: '' });
  });

  it('rango de gasto: del día 1 de hace 7 meses hasta ayer', () => {
    expect(rangoGasto(new Date('2026-11-17T10:00:00Z'))).toEqual({ desde: '2026-04-01', hasta: '2026-11-16' });
  });
});

describe('Marketing · ClickUp', () => {
  const tarea = (over: Record<string, unknown> = {}) => ({
    id: 'abc123', date_created: String(Date.parse('2026-10-05T09:00:00Z')),
    custom_fields: [
      { name: 'canal', type: 'short_text', value: '3' },
      { name: 'ETAPA_CRM', type: 'drop_down', value: 1, type_config: { options: [{ id: 'o0', name: 'e1 EN ESPERA', orderindex: 0 }, { id: 'o1', name: 'e5 DISEÑOS', orderindex: 1 }] } },
      { name: 'T_e4_visita', type: 'date', value: '1790000000000' },
      { name: 'T_e5_diseños_iniciales', type: 'date', value: '1790100000000' },
      { name: 'T_e11_seguimiento', type: 'date', value: null },
      { name: 'Categoría', type: 'drop_down', value: 'o2', type_config: { options: [{ id: 'o2', name: 'B', orderindex: 0 }] } },
      { name: 'presupuesto_estimado', type: 'currency', value: '55000' },
      { name: 'utm_campaign', type: 'short_text', value: 'Alicante Integral' },
    ],
    ...over,
  });

  it('convierte una tarea en lead sin datos personales; fases por sellos', () => {
    const lead = leadDesdeTarea(tarea({ name: 'María López' }) as never, 'sal')!;
    expect(lead).toMatchObject({ canal: 'meta', canal_origen: '3', etapa: 'e5 DISEÑOS', letra: 'B', importe_estimado: 55000, utm_campaign: 'Alicante Integral',
      llego_visita: true, llego_diseno: true, llego_seguimiento: false, llego_ganado: false });
    expect(JSON.stringify(lead)).not.toContain('María');
    expect(lead.lead_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(lead.lead_hash).not.toContain('abc123');
  });

  it('las subtareas no son leads', () => {
    expect(leadDesdeTarea(tarea({ parent: 'xyz' }) as never, 'sal')).toBeNull();
  });

  it('un sello posterior implica haber llegado a las fases anteriores', () => {
    const t = tarea({ custom_fields: [{ name: 'T_e14_ganado', type: 'date', value: '1790000000000' }] });
    expect(leadDesdeTarea(t as never, 's')).toMatchObject({ llego_visita: true, llego_diseno: true, llego_seguimiento: true, llego_ganado: true, canal: 'otro' });
  });

  it('valor de etiquetas y de desplegables por id u orden', () => {
    const opts = { options: [{ id: 'x', label: 'Uno' }, { id: 'y', label: 'Dos' }] };
    expect(valorCampo({ type: 'labels', value: ['y', 'x'], type_config: opts })).toBe('Dos, Uno');
    expect(valorCampo({ type: 'drop_down', value: 0, type_config: { options: [{ id: 'z', name: 'Cero', orderindex: 0 }] } })).toBe('Cero');
  });

  it('pagina hasta la última página y explica la falta de acceso', async () => {
    const pages: string[] = [];
    const f = (async (u: string) => {
      pages.push(new URL(u).searchParams.get('page')!);
      return jsonRes(pages.length === 1 ? { tasks: [tarea()], last_page: false } : { tasks: [tarea({ id: 'b' })], last_page: true });
    }) as typeof fetch;
    expect(await leerLeads({ token: 't', lista: 'L', sal: 's' }, f)).toHaveLength(2);
    expect(pages).toEqual(['0', '1']);
    await expect(leerLeads({ token: 't', lista: 'L', sal: 's' }, (async () => jsonRes({ ECODE: 'ACCESS_065', err: 'You do not have access to this Space' }, 401)) as typeof fetch))
      .rejects.toThrow('ClickUp respondió 401 (ACCESS_065: You do not have access to this Space)');
  });

  it('lista vacía por falta de permiso: explica el motivo real (ClickUp no da error al pedir las tareas)', async () => {
    const f = (async (u: string) => (u.includes('/task?')
      ? jsonRes({ tasks: [], last_page: true })
      : jsonRes({ err: 'You do not have access to this Space', ECODE: 'ACCESS_065' }, 401))) as typeof fetch;
    await expect(leerLeads({ token: 't', lista: 'L1', sal: 's' }, f)).rejects.toThrow('sin acceso a la lista L1 (ACCESS_065: You do not have access to this Space)');
  });

  it('una lectura vacía no borra los leads guardados', async () => {
    const pool = { connect: async () => { throw new Error('no debería conectar'); } } as unknown as Pool;
    await expect(guardarLeads(pool, [])).rejects.toThrow(/se conserva la carga anterior/);
  });
});

describe('Marketing · árbol y agregados', () => {
  const { periodos } = calcularPeriodos(new Date('2026-11-17T10:00:00Z'));
  const gasto = (over: Partial<FilaGastoPanel>): FilaGastoPanel => ({ fecha: '2026-10-20', canal: 'meta', campana_id: 'c1', campana: 'Alicante Integral', conjunto: 'Ren', anuncio_id: 'a1', anuncio: 'Cocina blanca', gasto: 100, ...over });
  const lead = (over: Partial<FilaLeadPanel>): FilaLeadPanel => ({
    dia: '2026-10-20', canal: 'meta', utm_campaign: 'Alicante Integral', utm_term: 'Ren', utm_content: 'Cocina blanca', anuncio_id: null,
    letra_entrada: 'A', letra_confirmada: 'B', llego_visita: true, llego_diseno: false, llego_seguimiento: false, llego_ganado: false, ...over,
  });

  it('árbol canal → zona → campaña → familia → creativo y gasto en el mes y en la semana', () => {
    const r = construirArbol({ periodos, gasto: [gasto({}), gasto({ canal: 'google', campana_id: 'g1', campana: 'Murcia Búsqueda', anuncio_id: '', anuncio: '', conjunto: '' })], leads: [], zonas: ZONAS, familias: FAMILIAS });
    const meta = r.tree.children!.find((c) => c.id === 'meta')!;
    expect(meta.children![0].name).toBe('Alicante');
    const familia = meta.children![0].children![0].children![0];
    expect(familia.name).toBe('Reformas de cocinas');
    expect(familia.children![0]).toMatchObject({ name: 'Cocina blanca', adId: 'a1' });
    const hoja = r.leaves.find((l) => l.id === 'meta|a:a1')!;
    expect(hoja.d[5].spend).toBe(100); // octubre
    expect(hoja.d[6].spend).toBe(100); // semana del 19 al 25 de octubre
    expect(r.leaves.find((l) => l.id === 'google|c:g1')!.d[5].spend).toBe(100);
    const conLeads = construirArbol({ periodos, gasto: [gasto({ leads_plataforma: 7 })], leads: [], zonas: ZONAS, familias: FAMILIAS });
    expect(conLeads.leaves.find((l) => l.id === 'meta|a:a1')!.d[5].leadsMeta).toBe(7); // leads que cuenta Meta, del lado del gasto
    expect(r.defaultChecked).toEqual(['google', 'meta|z:Alicante']);
  });

  it('dos anuncios con el mismo nombre: el lead va al del conjunto de utm_term y nunca se reparte', () => {
    const r = construirArbol({
      periodos,
      gasto: [gasto({ anuncio_id: 'a1', conjunto: 'Ren', gasto: 10 }), gasto({ anuncio_id: 'a2', conjunto: 'High', gasto: 90 })],
      leads: [lead({ utm_term: 'Ren' }), lead({ utm_term: 'Otro' })], zonas: ZONAS, familias: FAMILIAS,
    });
    const n = (id: string) => r.leaves.find((l) => l.id === id)!.d[5].n;
    expect(n('meta|a:a1')).toBe(1);
    expect(n('meta|a:a2')).toBe(1); // sin conjunto que coincida: el de más gasto
    expect(r.avisos.leads_por_nombre_ambiguo).toBe(2);
  });

  it('lead sin atribución: «Sin campaña», sin repartir; letras de entrada y confirmada; fases', () => {
    const r = construirArbol({ periodos, gasto: [gasto({})], leads: [lead({ utm_campaign: null }), lead({ letra_entrada: null, letra_confirmada: null, llego_visita: false })], zonas: ZONAS, familias: FAMILIAS });
    const sin = r.leaves.find((l) => l.id === 'meta|c:sin-campana')!.d[5];
    expect(sin).toMatchObject({ n: 1, obs: { lead: 1, visita: 1 } });
    const conocida = r.leaves.find((l) => l.id === 'meta|a:a1')!.d[5];
    expect(conocida.entry[conocida.entry.length - 1]).toBe(1); // «Sin valorar»
    expect(conocida.obs.visita).toBe(0);
    expect(r.avisos.leads_sin_atribucion).toBe(1);
    const total = r.leaves.reduce((a, l) => a + l.d[5].n, 0);
    expect(total).toBe(2); // cada lead en una sola hoja
  });

  it('Meta sin anuncio (gasto o lead) va a «Sin anuncio»: los datos siempre están en una hoja del árbol', () => {
    const r = construirArbol({ periodos, gasto: [gasto({}), gasto({ anuncio_id: '', anuncio: '' })], leads: [lead({ utm_content: null })], zonas: ZONAS, familias: FAMILIAS });
    const hojasArbol = new Set<string>();
    (function walk(n: { id: string; children?: unknown[] }) { if (!n.children?.length) hojasArbol.add(n.id); else (n.children as typeof n[]).forEach(walk); })(r.tree);
    expect(r.leaves.every((l) => hojasArbol.has(l.id))).toBe(true);
    expect(r.leaves.find((l) => l.id === 'meta|a:sin:c1')!.d[5]).toMatchObject({ n: 1, spend: 100 });
  });

  it('campañas que no son de captación («Ofertas de trabajo») quedan fuera; «Creación de marca» tiene zona propia', () => {
    const reglas = [...ZONAS, { patron: 'creacion de marca', valor: 'Marca (Alicante y Murcia)', prioridad: 100 }, { patron: 'ofertas de trabajo', valor: 'Excluida', prioridad: 100 }];
    const r = construirArbol({
      periodos, zonas: reglas, familias: FAMILIAS,
      gasto: [gasto({}), gasto({ campana_id: 'c9', campana: 'Ofertas de trabajo', anuncio_id: 'a9', gasto: 50 }), gasto({ campana_id: 'c8', campana: 'Creación de marca alicante', anuncio_id: 'a8' })],
      leads: [lead({ utm_campaign: 'Ofertas de trabajo' })],
    });
    const zonas = r.tree.children!.find((c) => c.id === 'meta')!.children!.map((z) => z.name);
    expect(zonas).toEqual(['Alicante', 'Marca (Alicante y Murcia)']);
    expect(r.leaves.some((l) => l.id === 'meta|a:a9')).toBe(false);
    expect(r.leaves.reduce((n, l) => n + l.d[5].n, 0)).toBe(0); // el lead de la oferta de empleo no cuenta
    expect(r.avisos.gasto_excluido).toBe(50);
  });

  it('Tally y canales manuales son hojas de primer nivel', () => {
    const r = construirArbol({ periodos, gasto: [], leads: [lead({ canal: 'tally', utm_campaign: null })], zonas: ZONAS, familias: FAMILIAS });
    expect(r.tree.children!.map((c) => c.id)).toEqual(['google', 'meta', 'tally']);
    expect(r.leaves.find((l) => l.id === 'tally')!.d[5].n).toBe(1);
  });

  it('nota comercial: media por fase y periodo, celebradas e intentos del SDR', () => {
    const notas = [
      { dia: '2026-10-20', extension: '120', nombre: 'SDR', rol: 'sdr', estado: 'evaluada', nota: 80 },
      { dia: '2026-10-21', extension: '120', nombre: 'SDR', rol: 'sdr', estado: 'evaluada', nota: 90 },
      { dia: '2026-10-22', extension: '120', nombre: 'SDR', rol: 'sdr', estado: 'no_evaluada', nota: null },
      { dia: '2026-10-22', extension: '115', nombre: 'Ernesto', rol: 'closer_f2', estado: 'evaluada', nota: 70 },
      { dia: '2026-10-23', extension: 'emp:e9', nombre: 'Closer F4', rol: 'closer_f4', estado: 'evaluada', nota: 90 }, // reunión de Meet, sin extensión
    ];
    const r = construirNotas(periodos, '2026-11-17', notas, [{ dia: '2026-10-20', extension: '120' }, { dia: '2026-10-20', extension: '120' }]);
    expect(r.slots).toHaveLength(16);
    const oct = r.slots.findIndex((s) => s.desde === '2026-10-01');
    const sdr = r.vendedores.find((v) => v.id === '120')!;
    expect(sdr.fases).toEqual(['F0']);
    expect(sdr.d.F0[oct]).toEqual({ n: 2, cel: 3, mean: 85, int: 2 });
    expect(r.vendedores.find((v) => v.id === '115')!.d.F2[oct].mean).toBe(70);
    expect(r.vendedores.find((v) => v.id === 'emp:e9')!.d.F4[oct].mean).toBe(90);
  });
});

describe('Marketing · carga diaria', () => {
  it('antes de la hora o sin claves no hay nada pendiente; después, las fuentes sin carga correcta hoy', async () => {
    const pool = { query: async () => ({ rows: [{ fuente: 'windsor' }] }) } as unknown as Pool;
    const env = { WINDSOR_API_KEY: 'k', CLICKUP_API_TOKEN: 't', MARKETING_CLICKUP_LIST: 'L1', MARKETING_CARGA_HORA: '6' };
    expect(await fuentesPendientesHoy(pool, env, new Date('2026-11-17T04:00:00Z'))).toEqual([]); // 05:00 en Madrid
    expect(await fuentesPendientesHoy(pool, env, new Date('2026-11-17T06:00:00Z'))).toEqual(['clickup']);
    expect(await fuentesPendientesHoy(pool, {}, new Date('2026-11-17T06:00:00Z'))).toEqual([]);
  });
});

describe('Marketing · API', () => {
  function app(role: string) {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
      connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; }, release: () => undefined }),
    } as unknown as Pool;
    const server = express();
    server.use(express.json());
    registerMarketing(server, { pool, admin: (_q, _s, next) => next(), role: () => role, fail: (res, e) => res.status(500).json({ error: String(e) }), env: {} });
    return { server, queries };
  }

  it('sin rol de Dirección: 403', async () => {
    const { server } = app('employee:comercial');
    expect((await request(server).get('/api/marketing/panel')).status).toBe(403);
  });

  it('un superadmin del directorio (employee:superadmin) ve y edita el panel (QA CAL-09)', async () => {
    const res = await request(app('employee:superadmin').server).get('/api/marketing/panel');
    expect(res.status).toBe(200);
    expect(res.body.permisos).toEqual({ editar: true, nota: true });
  });

  it('Dirección ve el panel con la nota comercial; la nota no se consulta sin permiso', async () => {
    const { server, queries } = app('employee:director');
    const res = await request(server).get('/api/marketing/panel');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ permisos: { editar: false, nota: true }, valoracion: null });
    expect(res.body.periodos).toHaveLength(10);
    expect(queries.some((q) => /llamada_evaluacion/.test(q))).toBe(true);

    const env = { MARKETING_NOTA_ROLES: 'superadmin' };
    const pool = { query: async (sql: string) => { if (/llamada_evaluacion/.test(sql)) throw new Error('no debería leer la nota'); return { rows: [] }; } } as unknown as Pool;
    const s2 = express();
    registerMarketing(s2, { pool, admin: (_q, _s, next) => next(), role: () => 'employee:director', fail: (r, e) => r.status(500).json({ error: String(e) }), env });
    const r2 = await request(s2).get('/api/marketing/panel');
    expect(r2.status).toBe(200);
    expect(r2.body.nota).toBeNull();
  });

  it('ponderaciones: solo quien puede editar; curvas de 0 a 1 que no bajan', async () => {
    expect((await request(app('employee:director').server).put('/api/marketing/ponderaciones').send({ valoresLetra: { B: 0.7 } })).status).toBe(403);
    const { server, queries } = app('superadmin');
    expect((await request(server).put('/api/marketing/ponderaciones').send({ curvas: { visita: [0.3, 0.2, 0.8, 0.95, 1, 1, 1] } })).status).toBe(400);
    expect((await request(server).put('/api/marketing/ponderaciones').send({ valoresLetra: { Z: 0.5 } })).status).toBe(400);
    const ok = await request(server).put('/api/marketing/ponderaciones').send({ valoresLetra: { B: 0.7 }, curvas: { visita: [0.3, 0.5, 0.8, 0.95, 1, 1, 1] } });
    expect(ok.status).toBe(200);
    expect(queries.filter((q) => /INSERT INTO mk_(valor_letra|curva_maduracion)/.test(q))).toHaveLength(2);
  });

  it('reglas: rechaza patrones repetidos y sustituye la tabla en una transacción', async () => {
    const { server, queries } = app('superadmin');
    expect((await request(server).put('/api/marketing/reglas').send({ zonas: [{ patron: 'a', valor: 'A' }, { patron: 'A', valor: 'B' }] })).status).toBe(400);
    const ok = await request(server).put('/api/marketing/reglas').send({ familias: [{ patron: 'Cocina', valor: 'Cocinas', prioridad: 1 }] });
    expect(ok.status).toBe(200);
    expect(queries).toEqual(expect.arrayContaining(['BEGIN', 'DELETE FROM mk_familia_creativa', 'COMMIT']));
    expect(queries).not.toContain('DELETE FROM mk_zona_regla');
  });

  it('carga manual sin fuentes configuradas: 409', async () => {
    expect((await request(app('superadmin').server).post('/api/marketing/cargar').send({})).status).toBe(409);
  });
});
