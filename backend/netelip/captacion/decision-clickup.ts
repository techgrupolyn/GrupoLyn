import type { Pool } from 'pg';
import { ClickUpClient, clickupConfigDesdeEnv } from './clickup.ts';
import { decisionFinalDelLead } from './decision-repositorio.ts';
import type { Db } from './repositorio.ts';

// N-1.4 · Refleja en la tarjeta del lead la decisión final y quién la tomó («Seguimiento · Ernesto»). Es informativo: no mueve la
// tarjeta de fase ni dispara nada (la integración ClickUp ↔ GHL cuelga de la fase, que aquí no se toca). El campo es de texto y lo
// crea un administrador; mientras no exista no se escribe nada y no es un error.

export const CAMPO_DECISION_PASE = 'Decisión de pase';

export type ResultadoSincronizacion =
  | { estado: 'escrito'; texto: string }
  | { estado: 'al_dia'; texto: string }
  | { estado: 'sin_decision' }
  | { estado: 'sin_campo' };

/**
 * Escribe la decisión final del lead en su tarjeta si no está ya. Solo toca el campo «Decisión de pase». Repetirlo es seguro.
 * `cliente` necesita leer los campos de la lista y la tarea y escribir un campo.
 */
export async function sincronizarDecisionPase(
  db: Db,
  cliente: Pick<ClickUpClient, 'campos' | 'tarea' | 'escribirCampo'>,
  leadId: string,
): Promise<ResultadoSincronizacion> {
  const texto = await decisionFinalDelLead(db, leadId);
  if (texto === null) return { estado: 'sin_decision' };
  const campo = (await cliente.campos()).find((c) => c.name === CAMPO_DECISION_PASE);
  if (!campo) return { estado: 'sin_campo' };
  const tarea = await cliente.tarea(leadId);
  const actual = tarea.campos[CAMPO_DECISION_PASE];
  if (typeof actual === 'string' && actual.trim() === texto) return { estado: 'al_dia', texto };
  await cliente.escribirCampo(leadId, campo.id, texto);
  return { estado: 'escrito', texto };
}

/**
 * Para el servidor: qué hacer tras revisar un caso. Con CLICKUP_API_TOKEN y CAPTACION_CLICKUP_LIST_ID configurados, refleja la decisión
 * final en la tarjeta; sin ellos no hace nada (undefined). El token solo sale hacia ClickUp.
 */
export function reflejoEnClickUp(pool: Pool, env: NodeJS.ProcessEnv = process.env): ((leadId: string) => Promise<ResultadoSincronizacion>) | undefined {
  const config = clickupConfigDesdeEnv(env);
  if (!config) return undefined;
  return async (leadId) => {
    const conexion = await pool.connect();
    try {
      return await sincronizarDecisionPase(conexion as unknown as Db, new ClickUpClient(config), leadId);
    } finally {
      conexion.release();
    }
  };
}