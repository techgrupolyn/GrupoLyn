// Encolado del calificador: se llama desde la transcripción de Netelip (processing.ts) sin importar
// el resto del calificador, para no crear una dependencia circular.
import type { Pool } from 'pg';
import { DURACION_MINIMA_SEGUNDOS } from './reglas.ts';

// Versión de la rúbrica vigente para el rol al encolar (869fpj8dm). Sin versión activa, NULL = fase0-v1.
const RUBRICA_ACTIVA = `(SELECT v.id FROM rubrica_version v WHERE v.rol = r.rol AND v.activo)`;
// Una sola evaluación automática por llamada: las reevaluaciones bajo demanda no cuentan.
const SIN_EVALUACION = `NOT EXISTS (SELECT 1 FROM llamada_evaluacion x WHERE x.llamada_id = c.id AND NOT x.reevaluacion)`;

/**
 * Crea la evaluación de una llamada si su extensión tiene un comercial activo y dura ≥ 60 s.
 * Idempotente: un evento repetido no crea otra evaluación.
 * Con `motivo`, la deja directamente como no evaluada (transcripción fallida).
 */
export async function encolarEvaluacion(pool: Pool, llamadaId: number | string, motivo: string | null = null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, estado, motivo_no_evaluada, rubrica_version_id)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol, CASE WHEN $2::text IS NULL THEN 'pendiente' ELSE 'no_evaluada' END, $2::text, ${RUBRICA_ACTIVA}
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     WHERE c.id = $1 AND c.duration_seconds >= $3 AND ${SIN_EVALUACION}
     ON CONFLICT DO NOTHING`,
    [llamadaId, motivo, DURACION_MINIMA_SEGUNDOS],
  );
  return Boolean(rowCount);
}

/** Recupera llamadas transcritas que no se encolaron (p. ej. el comercial se dio de alta después). */
export async function encolarPendientes(pool: Pool, dias = 2): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, rubrica_version_id)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol, ${RUBRICA_ACTIVA}
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.duration_seconds >= $1 AND t.completed_at >= NOW() - make_interval(days => $2) AND r.creado_en <= t.completed_at AND ${SIN_EVALUACION}
     ON CONFLICT DO NOTHING`,
    [DURACION_MINIMA_SEGUNDOS, dias],
  );
  return rowCount || 0;
}

