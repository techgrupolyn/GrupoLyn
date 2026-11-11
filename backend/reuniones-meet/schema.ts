// Calificador interno · reuniones de Meet de los closers (ticket 869fppbcj): tabla aditiva e idempotente,
// aplicada en cada arranque después de Drive, de las reuniones y del calificador de llamadas.
// Reversión: backend/reuniones-meet/schema-down.sql.
import type { Pool } from 'pg';

export const ESTADOS_REUNION = ['pendiente', 'por_evaluar', 'sin_rubrica', 'evaluada', 'sin_comercial', 'sin_consentimiento', 'error'] as const;
export type EstadoReunion = typeof ESTADOS_REUNION[number];
export const FASES_REUNION = ['F2', 'F3', 'F4'] as const;
export type FaseReunion = typeof FASES_REUNION[number];

type Consultable = Pick<Pool, 'query'>;

export async function ensureReunionesMeet(pool: Consultable): Promise<void> {
  await pool.query(`
    -- Una fila por transcripción de Meet importada desde Drive. La transcripción NO se copia: se lee de
    -- google_drive_artifacts.content_text (artifact_id), que es la referencia a la transcripción.
    CREATE TABLE IF NOT EXISTS reunion (
      id BIGSERIAL PRIMARY KEY,
      artifact_id UUID NOT NULL UNIQUE REFERENCES google_drive_artifacts(id) ON DELETE CASCADE,
      google_file_id VARCHAR(255) NOT NULL UNIQUE,  -- el mismo archivo visto desde dos cuentas es UNA reunión
      meet_code TEXT,                               -- código Meet (abc-defg-hij) si aparece en el título o el texto
      titulo TEXT NOT NULL,
      fecha_reunion DATE,
      duracion_segundos INTEGER CHECK (duracion_segundos IS NULL OR duracion_segundos >= 0),
      organizador_email TEXT,
      empleado_id VARCHAR(255) REFERENCES empleados(id) ON DELETE SET NULL,  -- el comercial evaluado
      rol TEXT,                                     -- rol en comercial_rol cuando se vinculó
      invitados JSONB NOT NULL DEFAULT '[]',        -- emails de los invitados (Calendar), para el lead
      lead_id TEXT,                                 -- contacto del CRM con coincidencia única; NULL = sin lead
      fase TEXT CHECK (fase IS NULL OR fase IN ('F2','F3','F4')),
      fase_origen TEXT CHECK (fase_origen IS NULL OR fase_origen IN ('titulo','crm')),
      estado TEXT NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente','por_evaluar','sin_rubrica','evaluada','sin_comercial','sin_consentimiento','error')),
      motivo TEXT,                                  -- por qué está en su estado, en una frase
      version_rubrica TEXT,                         -- la versión activa encontrada al vincular (por_evaluar)
      vinculada_en TIMESTAMPTZ,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Consulta de invitados a Calendar (invitados.ts). Columnas añadidas aparte para que valga también en una base
    -- donde la tabla ya exista.
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS invitados_en TIMESTAMPTZ;          -- NULL = sin consultar
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS invitados_motivo TEXT;             -- por qué no hay invitados
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS invitados_reintentar BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS reunion_invitados_pendientes ON reunion(invitados_en NULLS FIRST) WHERE invitados_en IS NULL OR invitados_reintentar;
    CREATE INDEX IF NOT EXISTS reunion_estado ON reunion(estado, actualizado_en);
    CREATE INDEX IF NOT EXISTS reunion_empleado_fecha ON reunion(empleado_id, fecha_reunion DESC);
  `);
}
