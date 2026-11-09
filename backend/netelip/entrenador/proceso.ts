// Actualización del documento del entrenador con las llamadas evaluadas desde la versión anterior:
// el botón crea la versión «procesando» y la respuesta vuelve enseguida; Gemini y Drive trabajan en
// segundo plano y el Dashboard consulta el estado. Una sola actualización a la vez (índice único).
import type { Pool } from 'pg';
import { notifyTech } from '../processing.ts';
import type { Evaluador } from '../calificador/modelo.ts';
import { aplicarPropuesta, propuestaVacia, PropuestaInvalida, validarPropuesta } from './documento.ts';
import { documentoDocx, NOMBRE_DOCX } from './docx.ts';
import { publicarDocx } from './drive.ts';
import { citasDelPeriodo, PROMPT_SISTEMA, promptUsuario, type LlamadaPeriodo } from './modelo.ts';

/** Una actualización que no terminó en este tiempo (reinicio del backend) se da por fallida. */
const PROCESANDO_CADUCA_MINUTOS = 20;
/** Tope de llamadas por actualización: las más recientes del periodo, para no desbordar el prompt. */
export const MAX_LLAMADAS = 120;

export class ErrorEntrenador extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export type DriveEntrenador = { carpetaId: string; token: () => Promise<string> };

/** Llamadas evaluadas en el periodo (por fecha de evaluación): lo que el calificador ya guardó, enmascarado. */
export async function llamadasDelPeriodo(pool: Pool, desde: Date | null, hasta: Date): Promise<LlamadaPeriodo[]> {
  const { rows } = await pool.query<{ id: string; rol: string; direction: string; duration_seconds: number; nota: number | null; apto: boolean | null;
    errores_criticos: Array<{ regla: string; cita: string }>; mejorar: Array<{ que: string; accion: string }>;
    objeciones: Array<{ tipo: string; cita: string; idea_contenido: string | null }> | null }>(
    `SELECT e.id, e.rol, c.direction, c.duration_seconds, e.nota, e.apto, e.errores_criticos, e.mejorar,
            (SELECT json_agg(json_build_object('tipo', o.tipo_objecion, 'cita', o.cita, 'idea_contenido', o.idea_contenido) ORDER BY o.id)
             FROM objecion_marketing o WHERE o.evaluacion_id = e.id) AS objeciones
     FROM llamada_evaluacion e JOIN netelip_calls c ON c.id = e.llamada_id
     WHERE e.estado = 'evaluada' AND ($1::timestamptz IS NULL OR e.actualizado_en > $1) AND e.actualizado_en <= $2
     ORDER BY e.actualizado_en DESC LIMIT ${MAX_LLAMADAS}`, [desde, hasta]);
  return rows.map((r) => ({
    id: String(r.id), rol: r.rol, direccion: r.direction, duracion: Number(r.duration_seconds) || 0, nota: r.nota, apto: r.apto,
    errores: (r.errores_criticos || []).map(({ regla, cita }) => ({ regla, cita })), mejorar: r.mejorar || [], objeciones: r.objeciones || [],
  }));
}

type Vigente = { numero: number; contenido: string; periodo_hasta: Date | null };

async function vigente(pool: Pool): Promise<Vigente> {
  const { rows: [v] } = await pool.query<Vigente>(`SELECT numero, contenido, periodo_hasta FROM entrenador_version WHERE estado = 'lista' ORDER BY numero DESC LIMIT 1`);
  if (!v) throw new ErrorEntrenador('No hay documento base del entrenador.', 500);
  return v;
}

/**
 * Crea la versión «procesando» con el periodo desde la versión vigente hasta ahora. Lanza 409 si ya hay
 * una en curso o si no hay llamadas evaluadas nuevas (no se gasta una versión ni una llamada a Gemini).
 */
export async function iniciarActualizacion(pool: Pool, autor: { id: string; nombre: string }): Promise<{ id: string; numero: number; llamadas: number }> {
  await pool.query(
    `UPDATE entrenador_version SET estado = 'error', error = 'No terminó (¿reinicio del backend?)', terminado_en = NOW()
     WHERE estado = 'procesando' AND creado_en < NOW() - make_interval(mins => $1)`, [PROCESANDO_CADUCA_MINUTOS]);
  const actual = await vigente(pool);
  const hasta = new Date();
  const { rows: [{ n }] } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM llamada_evaluacion WHERE estado = 'evaluada' AND ($1::timestamptz IS NULL OR actualizado_en > $1) AND actualizado_en <= $2`,
    [actual.periodo_hasta, hasta]);
  if (!n) throw new ErrorEntrenador('No hay llamadas evaluadas nuevas desde la última actualización.', 409);
  try {
    const { rows: [row] } = await pool.query<{ id: string; numero: number }>(
      `INSERT INTO entrenador_version (numero, estado, periodo_desde, periodo_hasta, llamadas, autor_id, autor_nombre)
       SELECT COALESCE(MAX(numero), 0) + 1, 'procesando', $1, $2, $3, $4, $5 FROM entrenador_version RETURNING id, numero`,
      [actual.periodo_hasta, hasta, Math.min(n, MAX_LLAMADAS), autor.id, autor.nombre]);
    return { id: String(row.id), numero: row.numero, llamadas: Math.min(n, MAX_LLAMADAS) };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ErrorEntrenador('Ya hay una actualización en curso.', 409);
    throw error;
  }
}

/** Gemini propone, el código valida y añade, y la versión queda «lista». Después se publica en Drive. */
export async function ejecutarActualizacion(pool: Pool, versionId: string, evaluar: Evaluador, drive: DriveEntrenador | null): Promise<void> {
  try {
    const { rows: [v] } = await pool.query<{ periodo_desde: Date | null; periodo_hasta: Date }>(
      `SELECT periodo_desde, periodo_hasta FROM entrenador_version WHERE id = $1 AND estado = 'procesando'`, [versionId]);
    if (!v) return;
    const actual = await vigente(pool);
    const llamadas = await llamadasDelPeriodo(pool, v.periodo_desde, v.periodo_hasta);
    const respuesta = await evaluar(PROMPT_SISTEMA, promptUsuario(actual.contenido, llamadas));
    const propuesta = validarPropuesta(respuesta.text, citasDelPeriodo(llamadas));
    const contenido = aplicarPropuesta(actual.contenido, propuesta, { desde: v.periodo_desde, hasta: v.periodo_hasta, llamadas: llamadas.length });
    const resumen = propuesta.resumen || (propuestaVacia(propuesta) ? 'Las llamadas del periodo no aportan nada nuevo al documento.' : '');
    await pool.query(
      `UPDATE entrenador_version SET estado = 'lista', contenido = $2, llamadas = $3, cambios = $4, resumen = $5, modelo = $6,
         tokens_entrada = $7, tokens_salida = $8, terminado_en = NOW() WHERE id = $1`,
      [versionId, contenido, llamadas.length, JSON.stringify({ objeciones: propuesta.objeciones, arquetipos: propuesta.arquetipos, frases: propuesta.frases }),
        resumen, respuesta.model, respuesta.inputTokens, respuesta.outputTokens]);
  } catch (error) {
    const mensaje = error instanceof PropuestaInvalida ? `respuesta del modelo no válida: ${error.message}` : (error as Error).message;
    await pool.query(`UPDATE entrenador_version SET estado = 'error', error = $2, terminado_en = NOW() WHERE id = $1`, [versionId, mensaje.slice(0, 500)]);
    await notifyTech('Entrenador: no se pudo actualizar el documento', { version_id: versionId, error: mensaje.slice(0, 300) });
    return;
  }
  if (drive) await publicarVersion(pool, versionId, drive);
}

/** Sube la versión a Drive sustituyendo el archivo de la versión anterior publicada. El error queda en la versión. */
export async function publicarVersion(pool: Pool, versionId: string, drive: DriveEntrenador, fetcher?: typeof fetch): Promise<void> {
  try {
    const { rows: [v] } = await pool.query<{ contenido: string }>(`SELECT contenido FROM entrenador_version WHERE id = $1 AND estado = 'lista'`, [versionId]);
    if (!v) throw new ErrorEntrenador('Solo se publica una versión lista.', 409);
    const { rows: [previo] } = await pool.query<{ drive_file_id: string }>(
      `SELECT drive_file_id FROM entrenador_version WHERE drive_file_id IS NOT NULL ORDER BY drive_publicado_en DESC NULLS LAST LIMIT 1`);
    const archivo = await publicarDocx({ token: await drive.token(), carpetaId: drive.carpetaId, fileId: previo?.drive_file_id || null,
      nombre: NOMBRE_DOCX, contenido: await documentoDocx(v.contenido), fetcher });
    await pool.query(
      `UPDATE entrenador_version SET drive_file_id = $2, drive_url = $3, drive_en_carpeta = $4, drive_publicado_en = NOW(), drive_error = NULL WHERE id = $1`,
      [versionId, archivo.id, archivo.url, archivo.enCarpeta]);
  } catch (error) {
    const mensaje = (error as Error).message.slice(0, 500);
    await pool.query(`UPDATE entrenador_version SET drive_error = $2 WHERE id = $1`, [versionId, mensaje]);
    await notifyTech('Entrenador: documento sin publicar en Drive', { version_id: versionId, error: mensaje.slice(0, 300) });
  }
}
