// Datos del panel: árbol de captación (canal → zona → campaña → familia → creativo) con agregados por hoja y
// periodo. Las hojas no se solapan, así que el navegador puede sumar cualquier selección sin contar dos veces
// un lead. Nada de lo que sale de aquí identifica a una persona.
import type { Pool } from 'pg';
import { familiaDeAnuncio, ZONA_EXCLUIDA, zonaDeCampana, type Regla } from './atribucion.ts';
import { calcularPeriodos, diaMadrid, periodosDelDia, ZONA_HORARIA, type Periodo } from './periodos.ts';
import { EDADES_CURVA, HITOS, LETRAS } from './schema.ts';

export const LETRAS_PANEL = [...LETRAS, 'Sin valorar'] as const;
const FASES = ['lead', 'visita', 'diseno', 'seguimiento', 'ganado'] as const;
type Fase = typeof FASES[number];

export type FilaGastoPanel = { fecha: string; canal: string; campana_id: string; campana: string; conjunto: string; anuncio_id: string; anuncio: string; gasto: number; leads_plataforma?: number };
export type FilaLeadPanel = {
  dia: string; canal: string; utm_campaign: string | null; utm_term: string | null; utm_content: string | null; anuncio_id: string | null;
  letra_entrada: string | null; letra_confirmada: string | null;
  llego_visita: boolean; llego_diseno: boolean; llego_seguimiento: boolean; llego_ganado: boolean;
};

// leadsMeta: leads que cuenta Meta (formularios), del lado del gasto. n/entry/obs: leads de ClickUp con letra y fase.
type Agregado = { n: number; entry: number[]; after: number[]; obs: Record<Fase, number>; spend: number; leadsMeta: number };
export type Nodo = { id: string; name: string; adId?: string; children?: Nodo[] };
export type HojaPanel = { id: string; d: Agregado[] };

const CANALES: Record<string, string> = { google: 'Google', meta: 'Meta', tally: 'Tally directo', otro: 'Otros canales' };
const plano = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const vacio = (): Agregado => ({
  n: 0, entry: LETRAS_PANEL.map(() => 0), after: LETRAS.map(() => 0),
  obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0, leadsMeta: 0,
});

/** Árbol mutable con hijos indexados por id; al final se ordena y se convierte en `Nodo`. */
class Arbol {
  private hijos = new Map<string, Map<string, { name: string; adId?: string; orden: number }>>();
  private gasto = new Map<string, number>();
  private orden = 0;
  add(padre: string, id: string, name: string, adId?: string) {
    if (!this.hijos.has(padre)) this.hijos.set(padre, new Map());
    const m = this.hijos.get(padre)!;
    if (!m.has(id)) m.set(id, { name, adId, orden: this.orden++ });
    return id;
  }
  sumarGasto(ids: string[], g: number) { for (const id of ids) this.gasto.set(id, (this.gasto.get(id) || 0) + g); }
  nodo(id: string, name: string, adId?: string): Nodo {
    const m = this.hijos.get(id);
    const n: Nodo = { id, name, ...(adId ? { adId } : {}) };
    if (m?.size) {
      // Más gasto primero; «Sin …» al final.
      const sin = (s: string) => (s.startsWith('Sin ') ? 1 : 0);
      n.children = [...m.entries()]
        .sort(([ia, a], [ib, b]) => sin(a.name) - sin(b.name) || (this.gasto.get(ib) || 0) - (this.gasto.get(ia) || 0) || a.orden - b.orden)
        .map(([cid, c]) => this.nodo(cid, c.name, c.adId));
    }
    return n;
  }
}

export type EntradaPanel = {
  periodos: Periodo[];
  gasto: FilaGastoPanel[];
  leads: FilaLeadPanel[];
  zonas: Regla[];
  familias: Regla[];
};

export function construirArbol(e: EntradaPanel) {
  const { periodos } = e;
  const arbol = new Arbol();
  const hojas = new Map<string, Agregado[]>();
  const hoja = (id: string) => { if (!hojas.has(id)) hojas.set(id, periodos.map(vacio)); return hojas.get(id)!; };
  for (const c of ['google', 'meta']) arbol.add('root', c, CANALES[c]);

  // Campañas conocidas por el gasto: nombre normalizado → id, para atribuir los leads por utm_campaign.
  const campanas = new Map<string, { canal: string; id: string; nombre: string }>();
  const anuncios = new Map<string, Array<{ id: string; conjunto: string; gasto: number }>>(); // campaña|nombre anuncio → ids
  const nodoCampana = (canal: string, campanaId: string, nombre: string) => {
    const zona = zonaDeCampana(nombre, e.zonas);
    const zId = arbol.add(canal, `${canal}|z:${zona}`, zona);
    return { zId, cId: arbol.add(zId, `${canal}|c:${campanaId}`, nombre) };
  };
  const nodoAnuncio = (cId: string, anuncioId: string, nombre: string) => {
    const familia = familiaDeAnuncio(nombre, e.familias);
    const fId = arbol.add(cId, `${cId}|f:${familia}`, familia);
    return { fId, aId: arbol.add(fId, `meta|a:${anuncioId}`, nombre || `Anuncio ${anuncioId}`, anuncioId) };
  };

  let gastoExcluido = 0;
  for (const g of e.gasto) {
    if (zonaDeCampana(g.campana, e.zonas) === ZONA_EXCLUIDA) { gastoExcluido += g.gasto; continue; }
    const { zId, cId } = nodoCampana(g.canal, g.campana_id, g.campana);
    campanas.set(`${g.canal}|${plano(g.campana)}`, { canal: g.canal, id: g.campana_id, nombre: g.campana });
    let hojaId = cId;
    const rama = [g.canal, zId, cId];
    if (g.canal === 'meta') {
      // Meta siempre acaba en un creativo: el gasto sin anuncio va a «Sin anuncio» de su campaña.
      const { fId, aId } = g.anuncio_id ? nodoAnuncio(cId, g.anuncio_id, g.anuncio) : nodoAnuncio(cId, `sin:${g.campana_id}`, 'Sin anuncio');
      hojaId = aId; rama.push(fId, aId);
      if (g.anuncio_id) {
        const k = `${g.campana_id}|${plano(g.anuncio)}`;
        const lista = anuncios.get(k) || [];
        const prev = lista.find((x) => x.id === g.anuncio_id);
        if (prev) prev.gasto += g.gasto; else lista.push({ id: g.anuncio_id, conjunto: plano(g.conjunto), gasto: g.gasto });
        anuncios.set(k, lista);
      }
    }
    arbol.sumarGasto(rama, g.gasto);
    const d = hoja(hojaId);
    for (const i of periodosDelDia(g.fecha, periodos)) { d[i].spend += g.gasto; d[i].leadsMeta += g.leads_plataforma || 0; }
  }

  let sinAtribucion = 0, anunciosPorNombre = 0;
  for (const l of e.leads) {
    const idx = periodosDelDia(l.dia, periodos);
    if (!idx.length) continue;
    let hojaId: string;
    if (l.canal === 'meta' || l.canal === 'google') {
      if (!l.utm_campaign) {
        sinAtribucion++;
        const zId = arbol.add(l.canal, `${l.canal}|z:Sin zona`, 'Sin zona');
        hojaId = arbol.add(zId, `${l.canal}|c:sin-campana`, 'Sin campaña');
      } else if (zonaDeCampana(l.utm_campaign, e.zonas) === ZONA_EXCLUIDA) {
        continue;
      } else {
        const conocida = campanas.get(`${l.canal}|${plano(l.utm_campaign)}`);
        const { cId } = nodoCampana(l.canal, conocida?.id ?? `nombre:${plano(l.utm_campaign)}`, conocida?.nombre ?? l.utm_campaign);
        hojaId = cId;
        if (l.canal === 'meta' && !l.anuncio_id && !l.utm_content) hojaId = nodoAnuncio(cId, `sin:${conocida?.id ?? plano(l.utm_campaign)}`, 'Sin anuncio').aId;
        else if (l.canal === 'meta') {
          // Por ID si llega; si no, por nombre. Con dos anuncios del mismo nombre gana el del conjunto
          // indicado en utm_term y, si sigue empatado, el de más gasto. Nunca se reparte un lead.
          let anuncioId = l.anuncio_id;
          if (!anuncioId && conocida) {
            const cands = (anuncios.get(`${conocida.id}|${plano(l.utm_content)}`) || [])
              .slice().sort((a, b) => Number(b.conjunto === plano(l.utm_term)) - Number(a.conjunto === plano(l.utm_term)) || b.gasto - a.gasto);
            anuncioId = cands[0]?.id ?? null;
            if (cands.length > 1) anunciosPorNombre++;
          }
          hojaId = nodoAnuncio(cId, anuncioId ?? `nombre:${plano(l.utm_content)}`, l.utm_content || 'Anuncio sin nombre').aId;
        }
      }
    } else {
      hojaId = arbol.add('root', l.canal, CANALES[l.canal] ?? CANALES.otro);
    }
    const d = hoja(hojaId);
    const iEntrada = LETRAS_PANEL.indexOf((l.letra_entrada ?? 'Sin valorar') as typeof LETRAS_PANEL[number]);
    const iConf = (LETRAS as readonly string[]).indexOf(l.letra_confirmada ?? '');
    for (const i of idx) {
      const a = d[i];
      a.n++; a.obs.lead++;
      a.entry[iEntrada < 0 ? LETRAS_PANEL.length - 1 : iEntrada]++;
      if (iConf >= 0) a.after[iConf]++;
      if (l.llego_visita) a.obs.visita++;
      if (l.llego_diseno) a.obs.diseno++;
      if (l.llego_seguimiento) a.obs.seguimiento++;
      if (l.llego_ganado) a.obs.ganado++;
    }
  }

  const tree = arbol.nodo('root', 'Todos los canales');
  // Por defecto (Alex, 08/11): Google y las zonas de Meta Alicante, Murcia y Sureste.
  const zonasMeta = tree.children?.find((c) => c.id === 'meta')?.children || [];
  const defecto = ['google', ...zonasMeta.filter((z) => ['alicante', 'murcia', 'sureste'].includes(plano(z.name))).map((z) => z.id)];
  return {
    tree,
    leaves: [...hojas.entries()].map(([id, d]) => ({ id, d })),
    defaultChecked: defecto,
    avisos: { leads_sin_atribucion: sinAtribucion, leads_por_nombre_ambiguo: anunciosPorNombre, gasto_excluido: Math.round(gastoExcluido * 100) / 100 },
  };
}

// ---------- nota comercial (gráfico 5): calificador interno ----------
const FASE_DE_ROL: Record<string, string> = { sdr: 'F0', closer_f2: 'F2', closer_f3: 'F3', closer_f4: 'F4' };
type FilaNota = { dia: string; extension: string; nombre: string | null; rol: string; estado: string; nota: number | null };
type FilaIntento = { dia: string; extension: string };

/** 12 meses completos (para media y objetivo) + las 4 semanas del panel. */
export function slotsNota(periodos: Periodo[], corte: string) {
  const [y, m] = corte.split('-').map(Number);
  const meses = Array.from({ length: 12 }, (_, k) => {
    const desde = new Date(Date.UTC(y, m - 1 - 12 + k, 1)).toISOString().slice(0, 10);
    const hasta = new Date(Date.UTC(y, m - 12 + k, 0)).toISOString().slice(0, 10);
    return { desde, hasta };
  });
  return [...meses, ...periodos.filter((p) => p.bloque === 1).map((p) => ({ desde: p.desde, hasta: p.hasta }))];
}

export function construirNotas(periodos: Periodo[], corte: string, notas: FilaNota[], intentos: FilaIntento[]) {
  const slots = slotsNota(periodos, corte);
  const enSlots = (dia: string) => slots.map((s, i) => (s.desde <= dia && dia <= s.hasta ? i : -1)).filter((i) => i >= 0);
  const vend = new Map<string, { id: string; name: string; fases: Set<string>; d: Map<string, { n: number; cel: number; suma: number; int: number }[]> }>();
  const get = (ext: string, nombre: string | null) => {
    if (!vend.has(ext)) vend.set(ext, { id: ext, name: nombre || `Ext. ${ext}`, fases: new Set(), d: new Map() });
    return vend.get(ext)!;
  };
  const celda = (v: ReturnType<typeof get>, fase: string) => {
    if (!v.d.has(fase)) v.d.set(fase, slots.map(() => ({ n: 0, cel: 0, suma: 0, int: 0 })));
    v.fases.add(fase);
    return v.d.get(fase)!;
  };
  for (const r of notas) {
    const fase = FASE_DE_ROL[r.rol];
    if (!fase) continue;
    const c = celda(get(r.extension, r.nombre), fase);
    for (const i of enSlots(r.dia)) {
      c[i].cel++;
      if (r.estado === 'evaluada' && r.nota != null) { c[i].n++; c[i].suma += r.nota; }
    }
  }
  for (const r of intentos) {
    const v = vend.get(r.extension);
    if (!v?.fases.has('F0')) continue;
    for (const i of enSlots(r.dia)) v.d.get('F0')![i].int++;
  }
  return {
    slots,
    vendedores: [...vend.values()].map((v) => ({
      id: v.id, name: v.name, fases: [...v.fases].sort(),
      d: Object.fromEntries([...v.d.entries()].map(([f, arr]) => [f, arr.map((x) => ({ n: x.n, cel: x.cel, mean: x.n ? x.suma / x.n : null, int: x.int }))])),
    })),
  };
}

// ---------- lectura de la base ----------
export async function datosPanel(pool: Pool, opciones: { ahora?: Date; conNota: boolean }) {
  const { corte, periodos } = calcularPeriodos(opciones.ahora);
  const desde = periodos.reduce((a, p) => (p.desde < a ? p.desde : a), periodos[0].desde);
  const hasta = periodos.reduce((a, p) => (p.hasta > a ? p.hasta : a), periodos[0].hasta);
  const [gasto, leads, zonas, familias, valores, curvas, cargas] = await Promise.all([
    pool.query(`SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, canal, campana_id, campana, conjunto, anuncio_id, anuncio, gasto::float8 AS gasto, leads_plataforma
                FROM mk_gasto_diario WHERE fecha BETWEEN $1 AND $2`, [desde, hasta]),
    pool.query(`SELECT to_char((fecha_alta AT TIME ZONE $3)::date,'YYYY-MM-DD') AS dia, canal, utm_campaign, utm_term, utm_content, anuncio_id,
                       letra_entrada, letra_confirmada, llego_visita, llego_diseno, llego_seguimiento, llego_ganado
                FROM mk_lead WHERE (fecha_alta AT TIME ZONE $3)::date BETWEEN $1 AND $2`, [desde, hasta, ZONA_HORARIA]),
    pool.query('SELECT patron, zona AS valor, prioridad FROM mk_zona_regla'),
    pool.query('SELECT patron, familia AS valor, prioridad FROM mk_familia_creativa'),
    pool.query('SELECT letra, valor::float8 AS valor FROM mk_valor_letra'),
    pool.query('SELECT hito, dias, fraccion::float8 AS fraccion FROM mk_curva_maduracion ORDER BY hito, dias'),
    pool.query(`SELECT DISTINCT ON (fuente) fuente, fin, estado, filas, detalle FROM mk_carga WHERE estado <> 'en_curso' ORDER BY fuente, inicio DESC`),
  ]);
  const arbol = construirArbol({ periodos, gasto: gasto.rows, leads: leads.rows, zonas: zonas.rows, familias: familias.rows });

  let nota = null;
  if (opciones.conNota) {
    const slots = slotsNota(periodos, corte);
    const params = [slots[0].desde, hasta, ZONA_HORARIA];
    const [n, it] = await Promise.all([
      // Llamadas de Netelip y reuniones de Meet (869fppbcj): una reunión no tiene extensión, su comercial sale de empleado_id.
      pool.query(`SELECT to_char(COALESCE((c.occurred_at AT TIME ZONE $3)::date, m.fecha_reunion),'YYYY-MM-DD') AS dia,
                         COALESCE(e.extension_netelip, 'emp:' || e.empleado_id, 'reunion') AS extension, COALESCE(r.nombre, r2.nombre) AS nombre,
                         COALESCE(e.rol, m.rol) AS rol, e.estado, e.nota
                  FROM llamada_evaluacion e
                  LEFT JOIN netelip_calls c ON c.id = e.llamada_id
                  LEFT JOIN reunion m ON m.id = e.reunion_id
                  LEFT JOIN comercial_rol r ON r.extension_netelip = e.extension_netelip
                  LEFT JOIN comercial_rol r2 ON e.extension_netelip IS NULL AND r2.empleado_id = e.empleado_id
                  WHERE NOT e.reevaluacion AND COALESCE((c.occurred_at AT TIME ZONE $3)::date, m.fecha_reunion) BETWEEN $1 AND $2`, params),
      pool.query(`SELECT to_char((c.occurred_at AT TIME ZONE $3)::date,'YYYY-MM-DD') AS dia, c.agent_extension AS extension
                  FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.rol = 'sdr'
                  WHERE (c.occurred_at AT TIME ZONE $3)::date BETWEEN $1 AND $2`, params),
    ]);
    nota = construirNotas(periodos, corte, n.rows, it.rows);
  }

  const curvasPorHito = Object.fromEntries(HITOS.map((h) => [h, EDADES_CURVA.map((d) => curvas.rows.find((c) => c.hito === h && c.dias === d)?.fraccion ?? 1)]));
  return {
    generado: new Date().toISOString(),
    corte,
    hoyMadrid: diaMadrid(opciones.ahora ?? new Date()),
    periodos,
    letras: LETRAS_PANEL,
    valoresLetra: Object.fromEntries(valores.rows.map((r) => [r.letra, r.valor])),
    edadesCurva: EDADES_CURVA,
    curvas: curvasPorHito,
    ...arbol,
    // El gráfico 4 necesita el histórico de letras del calificador de leads (N-1.2), que aún no existe.
    valoracion: null,
    nota,
    cargas: cargas.rows,
  };
}
