// Versiones del documento del entrenador de llamadas. Tabla aditiva e idempotente, aplicada en cada
// arranque después de las del calificador. Reversión: backend/netelip/entrenador/schema-down.sql.
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export const ENTRENADOR_TABLES = ['entrenador_version'] as const;

/** Versión 0: el «Contexto unificado» original de Jean Parra (05/11/2026), tal cual. */
// Saltos de línea LF aunque git lo haya sacado con CRLF (core.autocrlf en Windows): el texto se compara byte a byte.
export const DOCUMENTO_BASE = readFileSync(new URL('./base-v0.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

export async function ensureEntrenador(pool: Pool): Promise<void> {
  await pool.query(`
    -- Cada actualización es una versión nueva: el texto completo, el periodo de llamadas que cubre
    -- (desde la versión anterior) y qué se añadió. La última «lista» es la vigente.
    CREATE TABLE IF NOT EXISTS entrenador_version (
      id BIGSERIAL PRIMARY KEY,
      numero INTEGER NOT NULL UNIQUE,
      estado TEXT NOT NULL CHECK (estado IN ('procesando','lista','error')),
      contenido TEXT,
      periodo_desde TIMESTAMPTZ,                     -- NULL: desde el principio
      periodo_hasta TIMESTAMPTZ,                     -- NULL solo en la versión 0
      llamadas INTEGER NOT NULL DEFAULT 0,
      cambios JSONB NOT NULL DEFAULT '{}',           -- {objeciones, arquetipos, frases} añadidos
      resumen TEXT,
      error TEXT,
      autor_id TEXT,
      autor_nombre TEXT,
      modelo TEXT,
      tokens_entrada INTEGER,
      tokens_salida INTEGER,
      drive_file_id TEXT,
      drive_url TEXT,
      drive_en_carpeta BOOLEAN,
      drive_publicado_en TIMESTAMPTZ,
      drive_error TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      terminado_en TIMESTAMPTZ
    );
    -- Solo una actualización a la vez.
    CREATE UNIQUE INDEX IF NOT EXISTS entrenador_version_una_en_curso ON entrenador_version((TRUE)) WHERE estado = 'procesando';
  `);
  await pool.query(
    `INSERT INTO entrenador_version (numero, estado, contenido, resumen, terminado_en)
     VALUES (0, 'lista', $1, 'Documento original de Jean Parra (05/11/2026).', NOW()) ON CONFLICT (numero) DO NOTHING`,
    [DOCUMENTO_BASE]);
}
