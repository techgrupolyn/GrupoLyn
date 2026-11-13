// Leads de la lista «Contacto de Reforma» de ClickUp → mk_lead, sin datos personales. Solo lectura:
// el nombre de la tarea (que es el nombre del lead) nunca se lee ni se guarda; el identificador se seudonimiza.
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { canalDelLead, normalizarLetra } from './atribucion.ts';
import type { Fetch } from './windsor.ts';

const API = 'https://api.clickup.com/api/v2';
export type ClickupConfig = { token: string; lista: string; sal: string };

export function clickupConfigDesdeEnv(env: NodeJS.ProcessEnv): ClickupConfig | null {
  const token = String(env.CLICKUP_API_TOKEN || '').trim();
  const lista = String(env.MARKETING_CLICKUP_LIST || '').trim();
  if (!token || !lista) return null;
  return { token, lista, sal: env.MARKETING_HASH_SALT || 'lyn-panel-marketing' };
}

type CampoClickup = { name?: string; type?: string; value?: unknown; type_config?: { options?: Array<{ id?: string; name?: string; label?: string; orderindex?: number }> } };
type TareaClickup = { id: string; parent?: string | null; date_created?: string; custom_fields?: CampoClickup[] };

export type LeadMk = {
  lead_hash: string; fecha_alta: Date; canal: string; canal_origen: string | null;
  utm_campaign: string | null; utm_term: string | null; utm_content: string | null; anuncio_id: string | null;
  letra: string | null; importe_estimado: number | null; etapa: string | null;
  llego_visita: boolean; llego_diseno: boolean; llego_seguimiento: boolean; llego_ganado: boolean;
};

const clave = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Valor legible de un campo personalizado: opción para desplegables y etiquetas, texto para el resto. */
export function valorCampo(c: CampoClickup | undefined): string | null {
  if (!c || c.value == null || c.value === '') return null;
  const opciones = c.type_config?.options || [];
  if (c.type === 'drop_down') {
    const o = opciones.find((x) => x.id === c.value || x.orderindex === Number(c.value));
    return o?.name ?? null;
  }
  if (c.type === 'labels' && Array.isArray(c.value)) {
    return c.value.map((id) => opciones.find((x) => x.id === id)?.label ?? '').filter(Boolean).join(', ') || null;
  }
  if (typeof c.value === 'object') return null;
  return String(c.value).trim() || null;
}

// Hitos del embudo (ETAPA_CRM): «llegó a la fase k» = tiene el sello T_ek o el de una fase posterior.
const FASE = { visita: 4, diseno: 5, seguimiento: 11, ganado: 14 } as const;

export function leadDesdeTarea(t: TareaClickup, sal: string): LeadMk | null {
  if (t.parent) return null; // subtareas heredadas con ETAPA_CRM: no son leads
  const creado = Number(t.date_created);
  if (!Number.isFinite(creado) || creado <= 0) return null;
  const campos = new Map((t.custom_fields || []).map((c) => [clave(c.name), c] as const));
  const v = (...nombres: string[]) => { for (const n of nombres) { const x = valorCampo(campos.get(clave(n))); if (x) return x; } return null; };
  let faseMax = 0;
  for (const [nombre, c] of campos) {
    const m = nombre.match(/^t_e(\d+)(_|$)/);
    if (m && valorCampo(c)) faseMax = Math.max(faseMax, Number(m[1]));
  }
  const importe = Number(String(v('presupuesto_estimado') ?? '').replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.'));
  const canalOrigen = v('canal');
  return {
    lead_hash: createHmac('sha256', sal).update(t.id).digest('hex').slice(0, 32),
    fecha_alta: new Date(creado),
    canal: canalDelLead(v('utm_source'), canalOrigen),
    canal_origen: canalOrigen,
    utm_campaign: v('utm_campaign'), utm_term: v('utm_term'), utm_content: v('utm_content'),
    anuncio_id: v('utm_id', 'ad_id', 'anuncio_id'),
    letra: normalizarLetra(v('categoria', 'valoracion_interna')),
    importe_estimado: Number.isFinite(importe) && importe > 0 ? importe : null,
    etapa: v('etapa_crm'),
    llego_visita: faseMax >= FASE.visita, llego_diseno: faseMax >= FASE.diseno,
    llego_seguimiento: faseMax >= FASE.seguimiento, llego_ganado: faseMax >= FASE.ganado,
  };
}

export async function leerLeads(config: ClickupConfig, f: Fetch = fetch): Promise<LeadMk[]> {
  const out: LeadMk[] = [];
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ include_closed: 'true', subtasks: 'false', archived: 'false', page: String(page) });
    const res = await f(`${API}/list/${config.lista}/task?${q}`, { headers: { Authorization: config.token }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { ECODE?: string; err?: string };
      throw new Error(`ClickUp respondió ${res.status}${body.ECODE ? ` (${body.ECODE}: ${body.err})` : ''}`);
    }
    const body = await res.json() as { tasks?: TareaClickup[]; last_page?: boolean };
    for (const t of body.tasks || []) { const lead = leadDesdeTarea(t, config.sal); if (lead) out.push(lead); }
    if (body.last_page !== false || !body.tasks?.length) break;
  }
  // Sin permiso sobre el espacio, ClickUp no da error al pedir las tareas: devuelve una lista vacía.
  // Se comprueba la lista para explicar el motivo real (p. ej. ACCESS_065).
  if (!out.length) {
    const res = await f(`${API}/list/${config.lista}`, { headers: { Authorization: config.token }, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({})) as { ECODE?: string; err?: string };
    if (!res.ok || body.ECODE) throw new Error(`ClickUp: sin acceso a la lista ${config.lista} (${body.ECODE ?? res.status}: ${body.err ?? 'sin detalle'}). Pide acceso de lectura al espacio a un administrador.`);
  }
  return out;
}

/**
 * Sustituye los leads en una transacción. La letra de entrada es la primera que se vio y no se pisa;
 * la confirmada es siempre la vigente. Los leads que ya no están en la lista se borran.
 */
export async function guardarLeads(pool: Pool, leads: LeadMk[]): Promise<number> {
  // Una lista vacía es casi siempre un fallo de lectura o de permisos: no se vacía la tabla por ello.
  if (!leads.length) throw new Error('ClickUp no devolvió ningún lead: se conserva la carga anterior');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < leads.length; i += 500) {
      const lote = leads.slice(i, i + 500);
      const col = <K extends keyof LeadMk>(k: K) => lote.map((x) => x[k]);
      await client.query(
        `INSERT INTO mk_lead (lead_hash, fecha_alta, canal, canal_origen, utm_campaign, utm_term, utm_content, anuncio_id,
                              letra_entrada, letra_confirmada, importe_estimado, etapa, llego_visita, llego_diseno, llego_seguimiento, llego_ganado)
         SELECT h, fa, c, co, uc, ut, un, ai, l, l, ie, e, v, d, s, g
         FROM UNNEST($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::text[], $10::numeric[], $11::text[], $12::bool[], $13::bool[], $14::bool[], $15::bool[])
              AS t(h, fa, c, co, uc, ut, un, ai, l, ie, e, v, d, s, g)
         ON CONFLICT (lead_hash) DO UPDATE SET
           fecha_alta = EXCLUDED.fecha_alta, canal = EXCLUDED.canal, canal_origen = EXCLUDED.canal_origen,
           utm_campaign = EXCLUDED.utm_campaign, utm_term = EXCLUDED.utm_term, utm_content = EXCLUDED.utm_content, anuncio_id = EXCLUDED.anuncio_id,
           letra_entrada = COALESCE(mk_lead.letra_entrada, EXCLUDED.letra_entrada), letra_confirmada = EXCLUDED.letra_confirmada,
           importe_estimado = EXCLUDED.importe_estimado, etapa = EXCLUDED.etapa,
           llego_visita = EXCLUDED.llego_visita, llego_diseno = EXCLUDED.llego_diseno,
           llego_seguimiento = EXCLUDED.llego_seguimiento, llego_ganado = EXCLUDED.llego_ganado, actualizado_en = NOW()`,
        [col('lead_hash'), col('fecha_alta'), col('canal'), col('canal_origen'), col('utm_campaign'), col('utm_term'), col('utm_content'), col('anuncio_id'),
          col('letra'), col('importe_estimado'), col('etapa'), col('llego_visita'), col('llego_diseno'), col('llego_seguimiento'), col('llego_ganado')]);
    }
    await client.query('DELETE FROM mk_lead WHERE NOT (lead_hash = ANY($1::text[]))', [leads.map((l) => l.lead_hash)]);
    await client.query('COMMIT');
    return leads.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
