// Encolado del calificador: se llama desde la transcripción de Netelip (processing.ts) sin importar
// el resto del calificador, para no crear una dependencia circular.
import type { Pool } from 'pg';
import { DURACION_MINIMA_SEGUNDOS } from './reglas.ts';

/**
 * CAL-06: un rol solo se evalúa con su rúbrica versionada activa. La rúbrica fija fase0-v1 (rubrica-v1.md) es la
 * del SDR y solo le sirve de respaldo a él; un closer sin rúbrica propia no se evalúa (antes caía en la del SDR y
 * se le marcaban errores que en su fase no lo son, p. ej. el «±5 %» de Fase 2: CAL-05).
 * La llamada queda «no evaluada» con este motivo, visible en el Historial, igual que las reuniones de Meet quedan
 * `sin_rubrica`: el supervisor ve por qué no tiene nota en vez de una llamada sin rastro de evaluación.
 */
export const ROL_CON_RUBRICA_FIJA = 'sdr';
export const MOTIVO_SIN_RUBRICA = 'sin rúbrica para el rol';
export const motivoSinRubrica = (rol: string | null) => `${MOTIVO_SIN_RUBRICA} ${rol || 'desconocido'}`;

// Versión de la rúbrica vigente para el rol al encolar (869fpj8dm). Sin versión activa, NULL = fase0-v1 (solo SDR).
const RUBRICA_ACTIVA = 'LEFT JOIN rubrica_version v ON v.rol = r.rol AND v.activo';
const SIN_RUBRICA = `(v.id IS NULL AND r.rol <> '${ROL_CON_RUBRICA_FIJA}')`;
// Una sola evaluación automática por llamada: las reevaluaciones bajo demanda no cuentan, y las «sin rúbrica» tampoco:
// si el rol estrena rúbrica dentro de la ventana de encolarPendientes, la llamada se evalúa con ella (como
// reabrirSinRubrica en las reuniones). Mientras siga sin rúbrica, el índice (llamada_id, versión 0) frena el duplicado.
const SIN_EVALUACION = `NOT EXISTS (SELECT 1 FROM llamada_evaluacion x WHERE x.llamada_id = c.id AND NOT x.reevaluacion
       AND NOT (x.estado = 'no_evaluada' AND x.rubrica_version_id IS NULL AND x.motivo_no_evaluada LIKE '${MOTIVO_SIN_RUBRICA} %'))`;
const ESTADO = (motivo: string) => `CASE WHEN ${SIN_RUBRICA} OR ${motivo} IS NOT NULL THEN 'no_evaluada' ELSE 'pendiente' END`;
const MOTIVO = (motivo: string) => `CASE WHEN ${SIN_RUBRICA} THEN '${MOTIVO_SIN_RUBRICA} ' || r.rol ELSE ${motivo} END`;

/**
 * Crea la evaluación de una llamada si su extensión tiene un comercial activo y dura ≥ 60 s.
 * Idempotente: un evento repetido no crea otra evaluación.
 * Con `motivo`, la deja directamente como no evaluada (transcripción fallida); sin rúbrica para el rol, también.
 */
export async function encolarEvaluacion(pool: Pool, llamadaId: number | string, motivo: string | null = null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, estado, motivo_no_evaluada, rubrica_version_id)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol, ${ESTADO('$2::text')}, ${MOTIVO('$2::text')}, v.id
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     ${RUBRICA_ACTIVA}
     WHERE c.id = $1 AND c.duration_seconds >= $3 AND ${SIN_EVALUACION}
     ON CONFLICT DO NOTHING`,
    [llamadaId, motivo, DURACION_MINIMA_SEGUNDOS],
  );
  return Boolean(rowCount);
}

/** Recupera llamadas transcritas que no se encolaron (p. ej. el comercial se dio de alta después). */
export async function encolarPendientes(pool: Pool, dias = 2): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, empleado_id, rol, estado, motivo_no_evaluada, rubrica_version_id)
     SELECT c.id, r.extension_netelip, r.empleado_id, r.rol, ${ESTADO('NULL::text')}, ${MOTIVO('NULL::text')}, v.id
     FROM netelip_calls c JOIN comercial_rol r ON r.extension_netelip = c.agent_extension AND r.activo
     ${RUBRICA_ACTIVA}
     JOIN netelip_call_transcriptions t ON t.call_id = c.id AND t.status = 'completed'
     WHERE c.duration_seconds >= $1 AND t.completed_at >= NOW() - make_interval(days => $2) AND r.creado_en <= t.completed_at AND ${SIN_EVALUACION}
     ON CONFLICT DO NOTHING`,
    [DURACION_MINIMA_SEGUNDOS, dias],
  );
  return rowCount || 0;
}
