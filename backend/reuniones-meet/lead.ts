// Lead de cada reunión de Meet (869fppbcj, bloque B). Regla del ticket: el lead se vincula si los emails de los
// invitados coinciden con UN único contacto; si no, «sin lead». El lead es la tarea padre de la lista de ClickUp
// «Contacto de Reforma» y se guarda su clickup_task_id, el mismo identificador que usa el esquema de Mateo (N-1.1),
// porque el calificador de leads (869fnzbae) recibe la reunión con el lead ya puesto.
//
// La búsqueda en ClickUp (clickup.ts) llega como dependencia (`BuscarLead`). Sin token de ClickUp, las reuniones se
// quedan con lead_estado = 'pendiente'. El lead trae su ETAPA_CRM, que da la fase si el título no la dice.
//
//   lead_estado  pendiente   aún sin decidir (faltan los invitados o la búsqueda)
//                vinculado   un único contacto coincide → lead_id
//                sin_lead    ninguno o varios: no se adivina (869fnzbae no escribe nada en ningún lead)
import type { Pool } from 'pg';
import type { Invitado } from './invitados.ts';
import { faseDeEtapa } from './reglas.ts';

type Consultable = Pick<Pool, 'query'>;

export const LOTE_LEADS = 20;

/** Tareas padre de «Contacto de Reforma» cuyo email coincide con alguno de los dados (en minúsculas). */
export type BuscarLead = (emails: string[]) => Promise<Array<{ id: string; etapa?: string | null }>>;

export type DecisionLead = { lead_estado: 'vinculado' | 'sin_lead'; lead_id: string | null; lead_motivo: string | null; lead_etapa: string | null };

/** Solo los invitados externos sirven: los internos son del equipo y coincidirían con cualquier lead suyo. */
export function emailsExternos(invitados: Invitado[] | null | undefined): string[] {
  return [...new Set((invitados || []).filter((i) => !i.interno && i.email).map((i) => i.email.trim().toLowerCase()))];
}

export function decidirLead(externos: string[], candidatos: Array<{ id: string; etapa?: string | null }>): DecisionLead {
  if (!externos.length) return { lead_estado: 'sin_lead', lead_id: null, lead_motivo: 'La reunión no tiene invitados externos.', lead_etapa: null };
  const ids = [...new Set(candidatos.map((c) => String(c.id || '').trim()).filter(Boolean))];
  if (ids.length === 1) return { lead_estado: 'vinculado', lead_id: ids[0], lead_motivo: null, lead_etapa: candidatos.find((c) => String(c.id).trim() === ids[0])?.etapa ?? null };
  if (!ids.length) return { lead_estado: 'sin_lead', lead_id: null, lead_motivo: 'Ningún contacto de «Contacto de Reforma» coincide con los invitados.', lead_etapa: null };
  return { lead_estado: 'sin_lead', lead_id: null, lead_motivo: `Coinciden ${ids.length} contactos (${ids.slice(0, 5).join(', ')}): no se elige uno a ciegas.`, lead_etapa: null };
}

/**
 * Decide el lead de las reuniones pendientes cuya consulta de invitados ya terminó (con invitados o sin ellos).
 * Si la búsqueda falla, la reunión sigue `pendiente` y se corta el lote: la siguiente vuelta lo reintenta sin
 * insistir con todas a la vez. No toca `actualizado_en` (lo usa la revisión de las sin_comercial).
 */
export async function vincularLeads(pool: Consultable, buscarLead: BuscarLead, lote = LOTE_LEADS): Promise<number> {
  const { rows } = await pool.query<{ id: string; invitados: Invitado[] | null }>(
    `SELECT id, invitados FROM reunion
     WHERE lead_estado = 'pendiente' AND invitados_en IS NOT NULL AND NOT invitados_reintentar
     ORDER BY id LIMIT $1`,
    [lote],
  );
  let decididas = 0;
  for (const r of rows) {
    const externos = emailsExternos(r.invitados);
    let decision: DecisionLead;
    try {
      decision = decidirLead(externos, externos.length ? await buscarLead(externos) : []);
    } catch (error) {
      console.warn('[reuniones-meet] No se pudo buscar el lead:', (error as Error).message);
      break;
    }
    // Si la reunión quedó sin_rubrica por no tener fase y la etapa del lead la da, vuelve a pendiente para que la
    // vinculación la tome del CRM (P-01: manda el título; el CRM, cuando el título no la dice).
    const reabrir = decision.lead_estado === 'vinculado' && faseDeEtapa(decision.lead_etapa) !== null;
    const { rowCount } = await pool.query(
      `UPDATE reunion SET lead_estado = $2, lead_id = $3, lead_motivo = $4, lead_etapa = $5, lead_en = NOW(),
              estado = CASE WHEN $6 AND estado = 'sin_rubrica' AND fase IS NULL THEN 'pendiente' ELSE estado END
       WHERE id = $1 AND lead_estado = 'pendiente'`,
      [r.id, decision.lead_estado, decision.lead_id, decision.lead_motivo, decision.lead_etapa, reabrir],
    );
    decididas += rowCount || 0;
  }
  return decididas;
}
