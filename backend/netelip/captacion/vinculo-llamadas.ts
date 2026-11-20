// N-1.0 · Identificar el lead de cada llamada de Netelip (ticket 1an2gnq0c77). Cruza el teléfono de cada llamada (E.164) con el de las
// tarjetas padre de «Contacto de Reforma» y, si no hay coincidencia, el email (el de la ficha del Dashboard, cuando la llamada ya está
// enlazada a un lead o cliente de allí). Una coincidencia única vincula; varias NO se asignan solas y quedan en una lista para elegir a
// mano. SOLO LEE ClickUp: lo único que se escribe es `captacion_llamada_lead`, en la base propia.
import type { Pool } from 'pg';
import { aLeadCandidato, type ClickUpClient, type TareaClickUp } from './clickup.ts';
import { coincidenciasDeLlamada, vincularLlamadaConLead, type LeadCandidato } from './vinculacion.ts';

/** Una llamada sin lead se vuelve a mirar durante estos días (el lead puede crearse después de la llamada). */
export const VENTANA_REINTENTO_DIAS = 30;
export const VIGENCIA_LEADS_VINCULO_MS = 5 * 60_000;
/** El repaso del histórico recorre las llamadas de este tamaño en este (de la más antigua a la más reciente), sin tope total. */
export const LOTE_REPASO = 2000;

export interface LeadVinculo extends LeadCandidato {
  nombre: string;
}

export interface ResumenVinculo {
  revisadas: number;
  vinculadas: number;
  variasCoincidencias: number;
  sinCoincidencia: number;
  sinDatos: number;
  /** Identificador de la última llamada de este lote (solo cuando se recorre por lotes), para seguir desde ahí. */
  ultimoId?: number;
}

const vacio = (): ResumenVinculo => ({ revisadas: 0, vinculadas: 0, variasCoincidencias: 0, sinCoincidencia: 0, sinDatos: 0 });

/** Todas las tarjetas padre de la lista, de cualquier fase (también las cerradas: son las que tienen historial de llamadas). */
export function leadsParaVinculo(tareas: readonly TareaClickUp[]): LeadVinculo[] {
  return tareas.filter((t) => t.esPadre).map((t) => ({ ...aLeadCandidato(t), nombre: t.nombre }));
}

interface FilaLlamada {
  id: string;
  phone_e164: string | null;
  email: string | null;
}

/**
 * Vincula las llamadas que aún no tienen fila y re-mira las que quedaron sin lead. Las vinculadas (y todo lo asignado a mano) no se tocan.
 * `reintentarDesde`: hasta qué fecha de llamada se re-miran las que no coincidieron; null = todas (el repaso del histórico).
 */
export async function vincularLlamadas(
  pool: Pick<Pool, 'query'>,
  leads: readonly LeadVinculo[],
  opciones: { reintentarDesde?: Date | null; limite?: number; despuesDeId?: number } = {},
): Promise<ResumenVinculo> {
  const resumen = vacio();
  const nombre = new Map(leads.map((l) => [l.clickupTaskId, l.nombre]));
  const { rows } = await pool.query<FilaLlamada>(
    `SELECT c.id::text AS id, c.phone_e164, COALESCE(NULLIF(btrim(l.email), ''), NULLIF(btrim(cl.email), '')) AS email
       FROM netelip_calls c
       LEFT JOIN captacion_llamada_lead v ON v.call_id = c.id
       LEFT JOIN crm_leads l ON l.id = c.lead_id
       LEFT JOIN clientes cl ON cl.id = c.client_id
      WHERE (v.call_id IS NULL
         OR (v.origen = 'automatico' AND v.estado <> 'vinculada' AND ($1::timestamptz IS NULL OR c.occurred_at >= $1::timestamptz)))
        AND ($3::bigint IS NULL OR c.id > $3::bigint)
      ORDER BY ${opciones.despuesDeId === undefined ? 'c.occurred_at DESC, c.id DESC' : 'c.id ASC'}
      LIMIT $2`,
    [opciones.reintentarDesde === undefined ? null : opciones.reintentarDesde, opciones.limite ?? 5000, opciones.despuesDeId ?? null],
  );

  for (const fila of rows) {
    const contacto = { telefono: fila.phone_e164, email: fila.email };
    const v = vincularLlamadaConLead(contacto, leads);
    resumen.revisadas += 1;
    resumen.ultimoId = Math.max(resumen.ultimoId ?? 0, Number(fila.id));
    let estado: 'vinculada' | 'varias_coincidencias' | 'sin_coincidencia' | 'sin_datos';
    let tarea: string | null = null;
    let via: 'telefono' | 'email' | null = null;
    let candidatos: Array<{ id: string; nombre: string }> = [];
    if (v.estado === 'vinculado') {
      estado = 'vinculada';
      tarea = v.clickupTaskId;
      via = v.via;
      resumen.vinculadas += 1;
    } else if (v.motivo === 'varias_coincidencias') {
      estado = 'varias_coincidencias';
      candidatos = (coincidenciasDeLlamada(contacto, leads)?.ids ?? []).map((id) => ({ id, nombre: nombre.get(id) ?? '' }));
      resumen.variasCoincidencias += 1;
    } else if (v.motivo === 'sin_datos') {
      estado = 'sin_datos';
      resumen.sinDatos += 1;
    } else {
      estado = 'sin_coincidencia';
      resumen.sinCoincidencia += 1;
    }
    // Una asignación a mano (origen 'manual') nunca se pisa: el WHERE del DO UPDATE lo impide. Sin cambios, tampoco se reescribe la fila.
    await pool.query(
      `INSERT INTO captacion_llamada_lead (call_id, estado, clickup_task_id, lead_nombre, via, origen, candidatos)
       VALUES ($1::bigint, $2, $3, $4, $5, 'automatico', $6::jsonb)
       ON CONFLICT (call_id) DO UPDATE
          SET estado = EXCLUDED.estado, clickup_task_id = EXCLUDED.clickup_task_id, lead_nombre = EXCLUDED.lead_nombre, via = EXCLUDED.via,
              candidatos = EXCLUDED.candidatos, actualizado_en = now()
        WHERE captacion_llamada_lead.origen = 'automatico'
          AND (captacion_llamada_lead.estado, captacion_llamada_lead.clickup_task_id, captacion_llamada_lead.candidatos::text)
              IS DISTINCT FROM (EXCLUDED.estado, EXCLUDED.clickup_task_id, EXCLUDED.candidatos::text)`,
      [fila.id, estado, tarea, tarea ? (nombre.get(tarea) ?? null) : null, via, JSON.stringify(candidatos)],
    );
  }
  return resumen;
}

export interface DependenciasVinculador {
  pool: Pick<Pool, 'query'>;
  cliente: Pick<ClickUpClient, 'tareas'>;
  ahora?: () => number;
  vigenciaLeadsMs?: number;
  /** Tamaño de cada lote del repaso del histórico (por defecto LOTE_REPASO). */
  loteRepaso?: number;
  registro?: (mensaje: string) => void;
}

/** Lo que corre en el servicio: lee los leads de ClickUp (con una vigencia corta) y vincula las llamadas pendientes. */
export class VinculadorLlamadas {
  private cache: { cargadaEn: number; leads: LeadVinculo[] } | null = null;

  constructor(private readonly d: DependenciasVinculador) {}

  private ahora = (): number => (this.d.ahora ? this.d.ahora() : Date.now());

  private async leads(forzar: boolean): Promise<LeadVinculo[]> {
    const vigencia = this.d.vigenciaLeadsMs ?? VIGENCIA_LEADS_VINCULO_MS;
    if (!forzar && this.cache && this.ahora() - this.cache.cargadaEn < vigencia) return this.cache.leads;
    const tareas: TareaClickUp[] = [];
    for await (const t of this.d.cliente.tareas()) tareas.push(t);
    const leads = leadsParaVinculo(tareas);
    this.cache = { cargadaEn: this.ahora(), leads };
    this.d.registro?.(`ClickUp: ${leads.length} leads para el cruce de llamadas`);
    return leads;
  }

  /** Una pasada: las llamadas nuevas y las que quedaron sin lead en los últimos 30 días. */
  async ejecutar(): Promise<ResumenVinculo> {
    const leads = await this.leads(false);
    return vincularLlamadas(this.d.pool, leads, { reintentarDesde: new Date(this.ahora() - VENTANA_REINTENTO_DIAS * 86_400_000) });
  }

  /** El repaso del histórico: todas las llamadas sin lead, de cualquier fecha, con los leads recién leídos. */
  async repasarTodo(): Promise<ResumenVinculo> {
    const leads = await this.leads(true);
    const lote = this.d.loteRepaso ?? LOTE_REPASO;
    const total = vacio();
    let despuesDeId = 0;
    for (;;) {
      const r = await vincularLlamadas(this.d.pool, leads, { reintentarDesde: null, limite: lote, despuesDeId });
      total.revisadas += r.revisadas;
      total.vinculadas += r.vinculadas;
      total.variasCoincidencias += r.variasCoincidencias;
      total.sinCoincidencia += r.sinCoincidencia;
      total.sinDatos += r.sinDatos;
      if (r.revisadas < lote || r.ultimoId === undefined) return total;
      despuesDeId = r.ultimoId;
    }
  }
}
