// Ingesta y vinculación de las reuniones de Meet de los closers (869fppbcj).
//
//   ingestarTranscripciones   crea una fila `pendiente` por transcripción de Drive nueva (idempotente)
//   vincularPendientes        comercial (organizador), consentimiento, fase y rúbrica → estado
//   rubricaActiva             versión activa de rubrica_version para una fase (tabla de 869fpj8dm)
//   reabrirSinRubrica         al activar una rúbrica, devuelve las `sin_rubrica` a `pendiente`
//
// La evaluación con el modelo (estado `por_evaluar` → `evaluada`) llega cuando existan las rúbricas de los
// closers y la migración de llamada_evaluacion acordada con Juan. Hasta entonces ninguna reunión llama al modelo.
import type { Pool } from 'pg';
import { codigoMeet, duracionAproximada, faseDelTitulo, niegaGrabacion } from './reglas.ts';
import type { EstadoReunion, FaseReunion } from './schema.ts';

type Consultable = Pick<Pool, 'query'>;

export const LOTE_INGESTA = 200;
export const LOTE_VINCULACION = 50;

/**
 * Crea la fila de cada transcripción de Meet importada que aún no tenga reunión.
 * Idempotente: UNIQUE(artifact_id) y UNIQUE(google_file_id) con ON CONFLICT DO NOTHING; un mismo archivo visto
 * desde dos cuentas de Drive cuenta una vez (se queda el artefacto más antiguo, como hace la sincronización).
 */
export async function ingestarTranscripciones(pool: Consultable, lote = LOTE_INGESTA): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO reunion (artifact_id, google_file_id, titulo, fecha_reunion)
     SELECT DISTINCT ON (a.google_file_id) a.id, a.google_file_id, a.name, COALESCE(mr.meeting_date, a.source_modified_at::date)
     FROM google_drive_artifacts a
     JOIN google_drive_folders f ON f.id = a.folder_id AND f.enabled = TRUE
     JOIN google_drive_connections c ON c.id = a.connection_id AND c.revoked_at IS NULL
     LEFT JOIN meeting_reviews mr ON mr.artifact_id = a.id
     WHERE a.artifact_type = 'transcript'
       AND length(trim(COALESCE(a.content_text, ''))) > 0
       AND NOT EXISTS (SELECT 1 FROM reunion r WHERE r.google_file_id = a.google_file_id)
     ORDER BY a.google_file_id, a.created_at ASC
     LIMIT $1
     ON CONFLICT DO NOTHING`,
    [lote],
  );
  return rowCount || 0;
}

let avisoRubrica = false;

/**
 * Versión activa de la rúbrica para la fase de la reunión, o null.
 * rubrica_version la crea el ticket 869fpj8dm (Juan). Mientras no exista, o no tenga columna `fase`, no hay
 * rúbrica para ninguna fase de closer y la reunión queda `sin_rubrica` sin llamar al modelo.
 * Columnas supuestas (a confirmar con Juan): version, fase, activo, vigente_desde.
 */
export async function rubricaActiva(pool: Consultable, fase: FaseReunion): Promise<string | null> {
  const { rows } = await pool.query<{ existe: boolean; con_fase: boolean }>(
    `SELECT to_regclass('rubrica_version') IS NOT NULL AS existe,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'rubrica_version' AND column_name = 'fase') AS con_fase`,
  );
  if (!rows[0]?.existe || !rows[0]?.con_fase) return null;
  try {
    const activa = await pool.query<{ version: string }>(
      `SELECT version::text AS version FROM rubrica_version WHERE activo AND fase = $1 ORDER BY vigente_desde DESC NULLS LAST LIMIT 1`,
      [fase],
    );
    return activa.rows[0]?.version ?? null;
  } catch (error) {
    if (!avisoRubrica) console.warn('[reuniones-meet] rubrica_version no tiene las columnas esperadas:', (error as Error).message);
    avisoRubrica = true;
    return null;
  }
}

type Candidata = { id: string; artifact_id: string; titulo: string; estado: EstadoReunion; content_text: string | null };
type Organizador = { employee_id: string; email: string | null; activo: boolean };

export type Vinculacion = {
  estado: EstadoReunion; motivo: string | null; empleado_id: string | null; organizador_email: string | null; rol: string | null;
  fase: FaseReunion | null; fase_origen: 'titulo' | 'crm' | null; version_rubrica: string | null;
};

/** Decide el estado de una reunión. Orden: consentimiento (definitivo), comercial, fase y rúbrica. */
export async function decidirVinculacion(pool: Consultable, reunion: Candidata): Promise<Vinculacion> {
  const vacio: Vinculacion = { estado: 'pendiente', motivo: null, empleado_id: null, organizador_email: null, rol: null, fase: null, fase_origen: null, version_rubrica: null };
  const organizadores = await pool.query<Organizador>(
    `SELECT o.employee_id, e.email, e.activo FROM meeting_artifact_organizers o JOIN empleados e ON e.id = o.employee_id WHERE o.artifact_id = $1`,
    [reunion.artifact_id],
  );
  const organizador = organizadores.rows[0];
  const base = { ...vacio, empleado_id: organizador?.employee_id ?? null, organizador_email: organizador?.email?.toLowerCase() ?? null };

  // Va primero: es definitivo y protege aunque luego se dé de alta al comercial.
  if (niegaGrabacion(reunion.content_text)) return { ...base, estado: 'sin_consentimiento', motivo: 'Un participante se niega a que se grabe la reunión.' };
  if (!organizador) return { ...base, estado: 'sin_comercial', motivo: 'Calendar no identifica al organizador y nadie lo ha vinculado a mano.' };
  if (!organizador.activo) return { ...base, estado: 'sin_comercial', motivo: 'El organizador está inactivo.' };

  const comercial = await pool.query<{ rol: string }>(
    `SELECT rol FROM comercial_rol WHERE empleado_id = $1 AND activo ORDER BY (rol = 'sdr') ASC, actualizado_en DESC LIMIT 1`,
    [organizador.employee_id],
  );
  const rol = comercial.rows[0]?.rol ?? null;
  if (!rol) return { ...base, estado: 'sin_comercial', motivo: 'El organizador no está dado de alta como comercial.' };

  // P-01: el título del evento manda. La fase del lead en el CRM ese día queda pendiente (CRM sin localizar).
  const fase = faseDelTitulo(reunion.titulo);
  const conFase = { ...base, rol, fase, fase_origen: fase ? 'titulo' as const : null };
  if (!fase) return { ...conFase, estado: 'sin_rubrica', motivo: 'Sin fase: el título no la indica y el CRM aún no está conectado.' };

  const version = await rubricaActiva(pool, fase);
  if (!version) return { ...conFase, estado: 'sin_rubrica', motivo: `No hay rúbrica activa para ${fase}.` };
  return { ...conFase, estado: 'por_evaluar', motivo: null, version_rubrica: version };
}

/**
 * Vincula las reuniones `pendiente` y vuelve a mirar las `sin_comercial` cuando cambió algo que lo resuelve
 * (alguien vinculó al organizador a mano o se dio de alta un comercial). Devuelve cuántas cambió.
 * La actualización exige que el estado no haya cambiado mientras tanto (concurrencia optimista).
 */
export async function vincularPendientes(pool: Consultable, lote = LOTE_VINCULACION): Promise<number> {
  const { rows } = await pool.query<Candidata>(
    `SELECT r.id, r.artifact_id, r.titulo, r.estado, a.content_text
     FROM reunion r JOIN google_drive_artifacts a ON a.id = r.artifact_id
     WHERE r.estado = 'pendiente'
        OR (r.estado = 'sin_comercial' AND (
              EXISTS (SELECT 1 FROM meeting_artifact_organizers o WHERE o.artifact_id = r.artifact_id AND o.assigned_at > r.actualizado_en)
           OR EXISTS (SELECT 1 FROM comercial_rol cr WHERE cr.actualizado_en > r.actualizado_en)))
     ORDER BY r.id
     LIMIT $1`,
    [lote],
  );
  let cambiadas = 0;
  for (const reunion of rows) {
    let v: Vinculacion;
    try {
      v = await decidirVinculacion(pool, reunion);
    } catch (error) {
      v = { estado: 'error', motivo: `No se pudo vincular: ${(error as Error).message}`.slice(0, 500), empleado_id: null, organizador_email: null, rol: null, fase: null, fase_origen: null, version_rubrica: null };
    }
    const { rowCount } = await pool.query(
      `UPDATE reunion SET estado = $3, motivo = $4, empleado_id = COALESCE($5, empleado_id), organizador_email = COALESCE($6, organizador_email),
              rol = $7, fase = $8, fase_origen = $9, version_rubrica = $10,
              meet_code = COALESCE(meet_code, $11), duracion_segundos = COALESCE(duracion_segundos, $12),
              vinculada_en = NOW(), actualizado_en = NOW()
       WHERE id = $1 AND estado = $2`,
      [reunion.id, reunion.estado, v.estado, v.motivo, v.empleado_id, v.organizador_email, v.rol, v.fase, v.fase_origen, v.version_rubrica,
        codigoMeet(reunion.titulo, reunion.content_text?.slice(0, 2_000)), duracionAproximada(reunion.content_text)],
    );
    cambiadas += rowCount || 0;
  }
  return cambiadas;
}

/**
 * Al activar una rúbrica nueva, devuelve a `pendiente` las reuniones `sin_rubrica` (de una fase o todas) para que la
 * vinculación las pase a `por_evaluar`. Nunca toca `sin_consentimiento`. La lanza el script de reevaluación de 869fpj8dm.
 */
export async function reabrirSinRubrica(pool: Consultable, fase: FaseReunion | null = null): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE reunion SET estado = 'pendiente', motivo = NULL, actualizado_en = NOW()
     WHERE estado = 'sin_rubrica' AND ($1::text IS NULL OR fase = $1)`,
    [fase],
  );
  return rowCount || 0;
}
