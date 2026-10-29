import type { Pool } from 'pg';
import type { ProtocolCorpus } from './protocol-corpus.ts';
import type { ProtocolLog } from './protocol-agent.ts';
import type { ProtocolSyncReport } from './protocol-drive.ts';

export async function ensureProtocolSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agente_protocolos_corpus (
      id CHAR(64) PRIMARY KEY,
      creado_en TIMESTAMPTZ NOT NULL,
      archivos JSONB NOT NULL,
      tokens_estimados INTEGER NOT NULL,
      activo BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agente_protocolos_corpus_activo ON agente_protocolos_corpus(activo) WHERE activo;
    CREATE TABLE IF NOT EXISTS agente_protocolos_consultas (
      id UUID PRIMARY KEY,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      cargo TEXT NOT NULL,
      canal TEXT NOT NULL DEFAULT 'superagente',
      pregunta TEXT NOT NULL,
      respuesta TEXT NOT NULL,
      clasificacion TEXT NOT NULL,
      motivo_no_respuesta TEXT,
      area TEXT NOT NULL,
      tema TEXT NOT NULL,
      fuentes JSONB NOT NULL DEFAULT '[]'::jsonb,
      cargo_derivacion TEXT,
      contradiccion JSONB,
      validacion TEXT NOT NULL,
      resuelta_por_usuario BOOLEAN,
      corpus_version_id CHAR(64) NOT NULL REFERENCES agente_protocolos_corpus(id),
      modelo TEXT,
      tokens_entrada INTEGER,
      tokens_salida INTEGER,
      latencia_ms INTEGER NOT NULL,
      error TEXT
    );
    ALTER TABLE agente_protocolos_consultas ADD COLUMN IF NOT EXISTS tokens_entrada INTEGER;
    ALTER TABLE agente_protocolos_consultas ADD COLUMN IF NOT EXISTS tokens_salida INTEGER;
    CREATE INDEX IF NOT EXISTS idx_agente_protocolos_consultas_usuario ON agente_protocolos_consultas(usuario_id, creado_en DESC);
    CREATE INDEX IF NOT EXISTS idx_agente_protocolos_consultas_reporte ON agente_protocolos_consultas(creado_en DESC, tema);
    CREATE TABLE IF NOT EXISTS agente_protocolos_syncs (
      id BIGSERIAL PRIMARY KEY,
      comprobado_en TIMESTAMPTZ NOT NULL,
      informe JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agente_protocolos_vision_cache (
      archivo_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      pagina TEXT NOT NULL,
      imagen_sha256 CHAR(64) NOT NULL,
      markdown TEXT NOT NULL,
      verificado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (archivo_id, revision, pagina)
    );
  `);
}

export async function loadProtocolVisionCache(pool: Pool, fileId: string, revision: string, page: string, imageHash: string): Promise<string | null> {
  const result = await pool.query<{ markdown: string }>(
    'SELECT markdown FROM agente_protocolos_vision_cache WHERE archivo_id=$1 AND pagina=$3 AND imagen_sha256=$4 ORDER BY (revision=$2) DESC, verificado_en DESC LIMIT 1',
    [fileId, revision, page, imageHash],
  );
  return result.rows[0]?.markdown || null;
}

export async function saveProtocolVisionCache(pool: Pool, fileId: string, revision: string, page: string, imageHash: string, markdown: string): Promise<void> {
  await pool.query(
    `INSERT INTO agente_protocolos_vision_cache (archivo_id, revision, pagina, imagen_sha256, markdown)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (archivo_id, revision, pagina) DO UPDATE SET imagen_sha256=$4, markdown=$5, verificado_en=NOW()`,
    [fileId, revision, page, imageHash, markdown],
  );
}

export async function saveProtocolSyncReport(pool: Pool, report: ProtocolSyncReport): Promise<void> {
  await pool.query('INSERT INTO agente_protocolos_syncs (comprobado_en, informe) VALUES ($1, $2::jsonb)', [report.checkedAt, JSON.stringify(report)]);
}

export async function loadProtocolSyncReport(pool: Pool): Promise<ProtocolSyncReport | null> {
  const result = await pool.query<{ informe: ProtocolSyncReport }>('SELECT informe FROM agente_protocolos_syncs ORDER BY id DESC LIMIT 1');
  return result.rows[0]?.informe || null;
}

export async function loadProtocolCorpus(pool: Pool): Promise<ProtocolCorpus | null> {
  const result = await pool.query<{ id: string; creado_en: Date; archivos: ProtocolCorpus['files']; tokens_estimados: number }>(
    'SELECT id, creado_en, archivos, tokens_estimados FROM agente_protocolos_corpus WHERE activo = TRUE LIMIT 1',
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id.trim(), createdAt: row.creado_en.toISOString(), files: row.archivos, documents: row.archivos.map(file => ({ id: file.id, sections: file.sections })), tokenEstimate: row.tokens_estimados };
}

export async function saveProtocolCorpus(pool: Pool, corpus: ProtocolCorpus): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE agente_protocolos_corpus SET activo = FALSE WHERE activo = TRUE AND id <> $1', [corpus.id]);
    await client.query(
      `INSERT INTO agente_protocolos_corpus (id, creado_en, archivos, tokens_estimados, activo)
       VALUES ($1, $2, $3::jsonb, $4, TRUE)
       ON CONFLICT (id) DO UPDATE SET activo = TRUE`,
      [corpus.id, corpus.createdAt, JSON.stringify(corpus.files), corpus.tokenEstimate],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveProtocolQuery(pool: Pool, log: ProtocolLog): Promise<void> {
  await pool.query(
    `INSERT INTO agente_protocolos_consultas (
      id, usuario_id, cargo, pregunta, respuesta, clasificacion, motivo_no_respuesta, area, tema,
      fuentes, cargo_derivacion, contradiccion, validacion, corpus_version_id, modelo, tokens_entrada, tokens_salida, latencia_ms, error
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)`,
    [log.id, log.userId, log.role, log.question, log.answer, log.classification, log.reason,
      log.area, log.topic, JSON.stringify(log.sources), log.derivationRole, JSON.stringify(log.contradiction),
      log.validation, log.corpusVersionId, log.model, log.inputTokens, log.outputTokens, log.latencyMs, log.error],
  );
}

export async function pruneProtocolQueries(pool: Pool): Promise<number> {
  const result = await pool.query("DELETE FROM agente_protocolos_consultas WHERE creado_en < NOW() - INTERVAL '12 months'");
  return result.rowCount || 0;
}

export const PROTOCOL_QUERY_PAGE_SIZE = 10;

export async function listProtocolQueries(pool: Pool, offset: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, creado_en, usuario_id, cargo, canal, pregunta, respuesta, clasificacion,
            motivo_no_respuesta, area, tema, fuentes, cargo_derivacion, contradiccion,
            validacion, resuelta_por_usuario, corpus_version_id, modelo,
            tokens_entrada, tokens_salida, latencia_ms, error
     FROM agente_protocolos_consultas ORDER BY creado_en DESC, id DESC LIMIT $2 OFFSET $1`,
    [offset, PROTOCOL_QUERY_PAGE_SIZE],
  );
  return result.rows;
}

export async function countProtocolQueries(pool: Pool): Promise<number> {
  const result = await pool.query<{ total: string }>('SELECT COUNT(*) AS total FROM agente_protocolos_consultas');
  return Number(result.rows[0]?.total || 0);
}

export async function recordProtocolFeedback(pool: Pool, id: string, userId: number, resolved: boolean): Promise<boolean> {
  const result = await pool.query(
    'UPDATE agente_protocolos_consultas SET resuelta_por_usuario=$3 WHERE id=$1 AND usuario_id=$2 AND resuelta_por_usuario IS NULL RETURNING id',
    [id, userId, resolved],
  );
  return result.rowCount === 1;
}
