// Gasto diario de Meta Ads (y de Google Ads cuando se conecte) desde la API de Windsor.ai. Solo lectura:
// Windsor actúa como conector y el panel nunca le pide acciones de escritura.
import type { Pool } from 'pg';

const API = 'https://connectors.windsor.ai';
export type Fetch = typeof fetch;

export type FilaGasto = {
  fecha: string; canal: 'meta' | 'google'; campana_id: string; campana: string;
  conjunto_id: string; conjunto: string; anuncio_id: string; anuncio: string;
  gasto: number; clics: number; impresiones: number;
  /** Leads que cuenta la propia plataforma (Meta: actions_lead). No son los de ClickUp: sin letra ni fase. */
  leads: number;
};

type Conector = { canal: 'meta' | 'google'; conector: string; campos: string[]; cuentas?: string };

export type WindsorConfig = { apiKey: string; conectores: Conector[] };

/** Meta siempre; Google solo con MARKETING_WINDSOR_GOOGLE=true (en la PoC no se conectó). */
export function windsorConfigDesdeEnv(env: NodeJS.ProcessEnv): WindsorConfig | null {
  const apiKey = String(env.WINDSOR_API_KEY || '').trim();
  if (!apiKey) return null;
  const conectores: Conector[] = [{
    canal: 'meta', conector: 'facebook',
    campos: ['date', 'campaign_id', 'campaign', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'spend', 'clicks', 'impressions', 'actions_lead'],
    cuentas: env.MARKETING_WINDSOR_META_ACCOUNTS?.trim() || undefined,
  }];
  if (env.MARKETING_WINDSOR_GOOGLE === 'true') conectores.push({
    canal: 'google', conector: 'google_ads',
    campos: ['date', 'campaign_id', 'campaign', 'spend', 'clicks', 'impressions'],
    cuentas: env.MARKETING_WINDSOR_GOOGLE_ACCOUNTS?.trim() || undefined,
  });
  return { apiKey, conectores };
}

const txt = (v: unknown) => (v == null ? '' : String(v).trim());
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Convierte una fila de Windsor. Acepta variantes de nombre de campo (adset/adset_name, ad/ad_name). */
export function filaDesdeWindsor(canal: 'meta' | 'google', r: Record<string, unknown>): FilaGasto | null {
  const fecha = txt(r.date).slice(0, 10);
  const campana_id = txt(r.campaign_id) || txt(r.campaign);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !campana_id) return null;
  return {
    fecha, canal, campana_id, campana: txt(r.campaign) || campana_id,
    conjunto_id: canal === 'meta' ? txt(r.adset_id) : '', conjunto: canal === 'meta' ? txt(r.adset_name ?? r.adset) : '',
    anuncio_id: canal === 'meta' ? txt(r.ad_id) : '', anuncio: canal === 'meta' ? txt(r.ad_name ?? r.ad) : '',
    gasto: num(r.spend), clics: Math.round(num(r.clicks)), impresiones: Math.round(num(r.impressions)), leads: Math.round(num(r.actions_lead)),
  };
}

export async function leerWindsor(config: WindsorConfig, c: Conector, desde: string, hasta: string, f: Fetch = fetch): Promise<FilaGasto[]> {
  const q = new URLSearchParams({ api_key: config.apiKey, date_from: desde, date_to: hasta, fields: c.campos.join(',') });
  if (c.cuentas) q.set('select_accounts', c.cuentas);
  const res = await f(`${API}/${c.conector}?${q}`, { signal: AbortSignal.timeout(120_000) });
  // El mensaje de error nunca incluye la URL: lleva la clave.
  if (!res.ok) throw new Error(`Windsor ${c.conector} respondió ${res.status}`);
  const body = await res.json() as unknown;
  const filas = Array.isArray(body) ? body : (body as { data?: unknown[] })?.data;
  if (!Array.isArray(filas)) throw new Error(`Windsor ${c.conector}: respuesta sin filas`);
  // Varias filas con la misma clave (p. ej. por plataforma de publicación) se suman.
  const porClave = new Map<string, FilaGasto>();
  for (const raw of filas) {
    const fila = filaDesdeWindsor(c.canal, raw as Record<string, unknown>);
    if (!fila) continue;
    const k = [fila.fecha, fila.campana_id, fila.conjunto_id, fila.anuncio_id].join('|');
    const prev = porClave.get(k);
    if (prev) { prev.gasto += fila.gasto; prev.clics += fila.clics; prev.impresiones += fila.impresiones; prev.leads += fila.leads; } else porClave.set(k, fila);
  }
  return [...porClave.values()];
}

/** Sustituye el gasto del rango por canal en una transacción: la carga es idempotente y recoge correcciones. */
export async function guardarGasto(pool: Pool, canal: 'meta' | 'google', desde: string, hasta: string, filas: FilaGasto[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mk_gasto_diario WHERE canal = $1 AND fecha BETWEEN $2 AND $3', [canal, desde, hasta]);
    for (let i = 0; i < filas.length; i += 1000) {
      const lote = filas.slice(i, i + 1000);
      const col = <K extends keyof FilaGasto>(k: K) => lote.map((x) => x[k]);
      await client.query(
        `INSERT INTO mk_gasto_diario (fecha, canal, campana_id, campana, conjunto_id, conjunto, anuncio_id, anuncio, gasto, clics, impresiones, leads_plataforma)
         SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::int[], $11::int[], $12::int[])`,
        [col('fecha'), col('canal'), col('campana_id'), col('campana'), col('conjunto_id'), col('conjunto'), col('anuncio_id'), col('anuncio'), col('gasto'), col('clics'), col('impresiones'), col('leads')]);
    }
    await client.query('COMMIT');
    return filas.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cargarWindsor(pool: Pool, config: WindsorConfig, desde: string, hasta: string, f: Fetch = fetch): Promise<number> {
  let total = 0;
  for (const c of config.conectores) total += await guardarGasto(pool, c.canal, desde, hasta, await leerWindsor(config, c, desde, hasta, f));
  return total;
}
