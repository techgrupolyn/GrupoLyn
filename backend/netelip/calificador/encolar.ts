// Encolado del calificador: se llama desde la transcripción de Netelip (processing.ts) sin importar
// el resto del calificador, para no crear una dependencia circular.
import type { Pool } from 'pg';
import { DURACION_MINIMA_SEGUNDOS } from './reglas.ts';

/**
 * Crea la evaluación de una llamada si su extensión tiene un comercial activo y dura ≥ 60 s.
 * Idempotente (UNIQUE llamada_id): un evento repetido no crea otra evaluación.
 * Con `motivo`, la deja directamente como no evaluada (transcripción fallida).
 */
export async function encolarEvaluacion(pool: Pool, llamadaId: number | string, motivo: string | null = null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, estado, motivo_no_evaluada)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol, CASE WHEN $2::text IS NULL THEN 'pendiente' ELSE 'no_evaluada' END, $2::text
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     WHERE c.id = $1 AND c.duration_seconds >= $3
     ON CONFLICT (llamada_id) DO NOTHING`,
    [llamadaId, motivo, DURACION_MINIMA_SEGUNDOS],
  );
  return Boolean(rowCount);
}

/** Recupera llamadas transcritas que no se encolaron (p. ej. el comercial se dio de alta después). */
export async function encolarPendientes(pool: Pool, dias = 2): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.duration_seconds >= $1 AND t.completed_at >= NOW() - make_interval(days => $2) AND r.creado_en <= t.completed_at
     ON CONFLICT (llamada_id) DO NOTHING`,
    [DURACION_MINIMA_SEGUNDOS, dias],
  );
  return rowCount || 0;
}

