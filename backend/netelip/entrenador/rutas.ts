// API del documento del entrenador para el Dashboard: estado y versiones, el botón de actualizar,
// la descarga del .docx de cada versión y volver a publicar en Drive.
import type { Express, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { evaluadorGemini, type Evaluador } from '../calificador/modelo.ts';
import { canSupervise } from '../calificador/rutas.ts';
import { documentoDocx, MIME_DOCX, NOMBRE_DOCX } from './docx.ts';
import { SCHEMA_PROPUESTA } from './modelo.ts';
import { ejecutarActualizacion, ErrorEntrenador, iniciarActualizacion, publicarVersion, type DriveEntrenador } from './proceso.ts';

type Deps = {
  pool: Pool;
  access: RequestHandler;
  role: (res: Response) => string;
  actor?: (res: Response) => { id: string; nombre: string };
  fail: (res: Response, error: unknown) => void;
  env: NodeJS.ProcessEnv;
  /** Publicación en Drive; null si no está configurada (el documento se descarga desde el Dashboard). */
  drive?: DriveEntrenador | null;
  evaluar?: Evaluador | null;
};

const COLUMNAS = `id, numero, estado, periodo_desde, periodo_hasta, llamadas, resumen, error, autor_nombre, creado_en, terminado_en,
  jsonb_array_length(COALESCE(cambios->'objeciones', '[]')) AS objeciones, jsonb_array_length(COALESCE(cambios->'arquetipos', '[]')) AS arquetipos,
  jsonb_array_length(COALESCE(cambios->'frases', '[]')) AS frases, drive_url, drive_en_carpeta, drive_publicado_en, drive_error`;

export function registerEntrenador(app: Express, deps: Deps): void {
  const { pool, access, fail, env } = deps;
  // Prompt largo (el documento entero) y salida mayor que la del calificador.
  const evaluar = deps.evaluar !== undefined ? deps.evaluar : evaluadorGemini(env, fetch, { schema: SCHEMA_PROPUESTA, maxOutputTokens: 8192, timeoutMs: 240_000 });
  const drive = deps.drive || null;
  const numero = (raw: unknown) => { const n = Number(raw); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const errorEntrenador = (res: Response, error: unknown) => (error instanceof ErrorEntrenador ? res.status(error.status).json({ error: error.message }) : fail(res, error));

  app.get('/api/netelip/entrenador', access, async (_req, res) => {
    try {
      const { rows: versiones } = await pool.query(`SELECT ${COLUMNAS} FROM entrenador_version ORDER BY numero DESC LIMIT 50`);
      const vigente = versiones.find((v) => v.estado === 'lista') || null;
      const { rows: [{ n }] } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM llamada_evaluacion WHERE estado = 'evaluada' AND NOT reevaluacion AND ($1::timestamptz IS NULL OR actualizado_en > $1)`, [vigente?.periodo_hasta ?? null]);
      const { rows: [publicado] } = await pool.query(
        `SELECT numero, drive_url, drive_en_carpeta, drive_publicado_en FROM entrenador_version WHERE drive_url IS NOT NULL ORDER BY drive_publicado_en DESC LIMIT 1`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        vigente, publicado: publicado || null, en_curso: versiones.find((v) => v.estado === 'procesando') || null, llamadas_pendientes: n, versiones,
        can_update: canSupervise(deps.role(res), env), modelo_configurado: Boolean(evaluar), drive_configurado: Boolean(drive),
      });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/netelip/entrenador/actualizar', access, async (_req, res) => {
    if (!canSupervise(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para actualizar el documento del entrenador.' });
    if (!evaluar) return res.status(503).json({ error: 'Falta GOOGLE_GEMINI_API_KEY: no se puede actualizar el documento.' });
    try {
      const version = await iniciarActualizacion(pool, deps.actor?.(res) || { id: 'desconocido', nombre: 'Supervisor' });
      res.status(202).json(version);
      void ejecutarActualizacion(pool, version.id, evaluar, drive).catch((error) => console.error('[entrenador] Error al actualizar:', (error as Error).message));
    } catch (error) { errorEntrenador(res, error); }
  });

  // El documento no lleva datos de clientes (citas enmascaradas): lo descarga quien ve Historial de llamadas.
  app.get('/api/netelip/entrenador/versiones/:numero/docx', access, async (req, res) => {
    const n = numero(req.params.numero);
    if (n === null) return res.status(400).json({ error: 'Versión no válida.' });
    try {
      const { rows: [v] } = await pool.query<{ contenido: string }>(`SELECT contenido FROM entrenador_version WHERE numero = $1 AND estado = 'lista'`, [n]);
      if (!v) return res.status(404).json({ error: 'Versión no encontrada.' });
      res.setHeader('Content-Type', MIME_DOCX);
      res.setHeader('Content-Disposition', `attachment; filename="${NOMBRE_DOCX.replace('.docx', `_v${n}.docx`)}"`);
      res.send(await documentoDocx(v.contenido));
    } catch (error) { fail(res, error); }
  });

  // Reintento si falló Drive, o para volver a publicar una versión anterior.
  app.post('/api/netelip/entrenador/versiones/:numero/publicar', access, async (req, res) => {
    if (!canSupervise(deps.role(res), env)) return res.status(403).json({ error: 'No tienes permiso para publicar el documento del entrenador.' });
    if (!drive) return res.status(503).json({ error: 'La publicación en Google Drive no está configurada (ENTRENADOR_DRIVE_CARPETA y ENTRENADOR_DRIVE_CUENTA).' });
    const n = numero(req.params.numero);
    if (n === null) return res.status(400).json({ error: 'Versión no válida.' });
    try {
      const { rows: [v] } = await pool.query<{ id: string }>(`SELECT id FROM entrenador_version WHERE numero = $1 AND estado = 'lista'`, [n]);
      if (!v) return res.status(404).json({ error: 'Versión no encontrada.' });
      await publicarVersion(pool, String(v.id), drive);
      const { rows: [row] } = await pool.query(`SELECT ${COLUMNAS} FROM entrenador_version WHERE id = $1`, [v.id]);
      res.json(row);
    } catch (error) { errorEntrenador(res, error); }
  });
}
