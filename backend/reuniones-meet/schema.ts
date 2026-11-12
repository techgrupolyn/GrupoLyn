// Calificador interno · reuniones de Meet de los closers (ticket 869fppbcj): tabla aditiva e idempotente,
// aplicada en cada arranque después de Drive, de las reuniones y del calificador de llamadas.
// Reversión: backend/reuniones-meet/schema-down.sql.
import type { Pool } from 'pg';
import { adaptarCalificador } from './migracion-calificador.ts';

export const ESTADOS_REUNION = ['pendiente', 'por_evaluar', 'sin_rubrica', 'evaluada', 'no_evaluada', 'sin_comercial', 'sin_consentimiento', 'error'] as const;
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

    -- Id de la versión de rubrica_version encontrada al vincular (acuerdo con Juan, 11/11): la evaluación se
    -- encola con rubrica_version_id NOT NULL y UNIQUE (reunion_id, rubrica_version_id). TEXT para no depender del
    -- tipo del id de su tabla, que aún no existe; sin FK por lo mismo.
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS rubrica_version_id TEXT;

    -- Hora de inicio y fin del evento de Calendar (fecha_reunion es solo el día). Se rellenan con los invitados.
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS inicio TIMESTAMPTZ;
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS fin TIMESTAMPTZ;

    -- Estado no_evaluada: el modelo dice que no es una reunión comercial evaluable, o la transcripción no sirve.
    DO $$ DECLARE c RECORD; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('reunion') AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%sin_consentimiento%' AND pg_get_constraintdef(oid) NOT LIKE '%no_evaluada%' LOOP
        EXECUTE format('ALTER TABLE reunion DROP CONSTRAINT %I', c.conname);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('reunion') AND conname = 'reunion_estado_check') THEN
        ALTER TABLE reunion ADD CONSTRAINT reunion_estado_check
          CHECK (estado IN ('pendiente','por_evaluar','sin_rubrica','evaluada','no_evaluada','sin_comercial','sin_consentimiento','error'));
      END IF;
    END $$;

    -- Lead de la reunión (la tarea padre de «Contacto de Reforma», por su clickup_task_id), aparte del estado de
    -- evaluación: una reunión sin_rubrica puede tener ya su lead, y el calificador de leads (869fnzbae) lo necesita.
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS lead_estado TEXT NOT NULL DEFAULT 'pendiente';
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS lead_motivo TEXT;
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS lead_en TIMESTAMPTZ;
    ALTER TABLE reunion ADD COLUMN IF NOT EXISTS lead_etapa TEXT;                    -- ETAPA_CRM del lead al vincularlo
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reunion_lead_estado_check' AND conrelid = to_regclass('reunion')) THEN
        ALTER TABLE reunion ADD CONSTRAINT reunion_lead_estado_check CHECK (lead_estado IN ('pendiente','vinculado','sin_lead'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS reunion_lead_pendiente ON reunion(id) WHERE lead_estado = 'pendiente';
  `);
  // Antes del FK: adaptarCalificador crea llamada_evaluacion.reunion_id (acuerdo con Juan del 11/11).
  await adaptarCalificador(pool);
  await enlazarEvaluaciones(pool);
}

/**
 * FK llamada_evaluacion.reunion_id → reunion(id). La columna la crea adaptarCalificador (migracion-calificador.ts).
 * Se aplica en cada arranque y solo cuando la columna existe. ON DELETE RESTRICT: una reunión evaluada no se puede borrar sin borrar antes su evaluación (hoy
 * nadie borra artefactos de Drive; las conexiones se revocan, no se eliminan).
 */
export async function enlazarEvaluaciones(pool: Consultable): Promise<boolean> {
  // conrelid + to_regclass: la restricción se busca en la tabla del esquema actual, no por nombre en toda la base.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'llamada_evaluacion' AND column_name = 'reunion_id')
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'llamada_evaluacion_reunion_fk' AND conrelid = to_regclass('llamada_evaluacion')) THEN
        ALTER TABLE llamada_evaluacion ADD CONSTRAINT llamada_evaluacion_reunion_fk
          FOREIGN KEY (reunion_id) REFERENCES reunion(id) ON DELETE RESTRICT;
      END IF;
    END $$;`);
  const { rows } = await pool.query<{ aplicado: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llamada_evaluacion_reunion_fk' AND conrelid = to_regclass('llamada_evaluacion')) AS aplicado`,
  );
  return rows[0]?.aplicado === true;
}
