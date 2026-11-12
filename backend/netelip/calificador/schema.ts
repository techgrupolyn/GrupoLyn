// Calificador interno de llamadas (ticket 869e9y98n): tablas aditivas e idempotentes, aplicadas en
// cada arranque después de las de Netelip. Reversión: backend/netelip/calificador/schema-down.sql.
import type { Pool } from 'pg';

export const CALIFICADOR_TABLES = ['objecion_marketing', 'llamada_feedback_humano', 'llamada_evaluacion', 'rubrica_version', 'comercial_rol'] as const;
export const ROLES_COMERCIALES = ['sdr', 'closer_f2', 'closer_f3', 'closer_f4'] as const;  // closer_f4: 869fppbcj (reuniones de Meet)
export type RolComercial = typeof ROLES_COMERCIALES[number];

export async function ensureCalificador(pool: Pool): Promise<void> {
  await pool.query(`
    -- Extensión de Netelip → comercial evaluado. Sin fila activa, sus llamadas no se evalúan.
    CREATE TABLE IF NOT EXISTS comercial_rol (
      extension_netelip TEXT PRIMARY KEY,
      empleado_id VARCHAR(255) REFERENCES empleados(id) ON DELETE SET NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL CHECK (rol IN ('sdr','closer_f2','closer_f3')),
      whatsapp TEXT,                                 -- E.164 al que se envía su feedback
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Una evaluación por llamada (UNIQUE): un evento repetido no crea otra ni reenvía el feedback.
    CREATE TABLE IF NOT EXISTS llamada_evaluacion (
      id BIGSERIAL PRIMARY KEY,
      llamada_id BIGINT NOT NULL UNIQUE REFERENCES netelip_calls(id) ON DELETE CASCADE,
      extension_netelip TEXT NOT NULL,
      empleado_id VARCHAR(255) REFERENCES empleados(id) ON DELETE SET NULL,
      rol TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','procesando','evaluada','no_evaluada')),
      intentos SMALLINT NOT NULL DEFAULT 0,
      proximo_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      motivo_no_evaluada TEXT,
      nota SMALLINT CHECK (nota BETWEEN 0 AND 100),
      apto BOOLEAN,
      errores_criticos JSONB NOT NULL DEFAULT '[]',  -- [{regla, cita, marca_tiempo}] con cita verificada
      errores_descartados JSONB NOT NULL DEFAULT '[]', -- los que el código descartó, con el motivo
      bien TEXT[] NOT NULL DEFAULT '{}',
      mejorar JSONB NOT NULL DEFAULT '[]',           -- [{que, accion}]
      escalado BOOLEAN NOT NULL DEFAULT FALSE,
      motivo_escalado TEXT,
      duda BOOLEAN NOT NULL DEFAULT FALSE,
      motivo_duda TEXT,
      feedback_texto TEXT,                           -- lo que recibe el comercial (≤ 5 líneas, ≤ 600 caracteres)
      version_rubrica TEXT,
      modelo TEXT,
      tokens_entrada INTEGER,
      tokens_salida INTEGER,
      enviado_en TIMESTAMPTZ,
      envio_error TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS envio_intentos SMALLINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS llamada_evaluacion_cola ON llamada_evaluacion(proximo_intento) WHERE estado IN ('pendiente','procesando');
    CREATE INDEX IF NOT EXISTS llamada_evaluacion_envio ON llamada_evaluacion(id) WHERE estado = 'evaluada' AND enviado_en IS NULL;

    CREATE TABLE IF NOT EXISTS llamada_feedback_humano (
      id BIGSERIAL PRIMARY KEY,
      evaluacion_id BIGINT NOT NULL REFERENCES llamada_evaluacion(id) ON DELETE CASCADE,
      autor_id TEXT,
      autor_nombre TEXT,
      texto TEXT NOT NULL CHECK (length(texto) BETWEEN 1 AND 2000),
      enviado_en TIMESTAMPTZ,
      envio_error TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS llamada_feedback_humano_eval ON llamada_feedback_humano(evaluacion_id, creado_en);

    -- Objeciones del cliente e ideas de contenido para marketing. Sin datos personales: la cita sale
    -- de la transcripción ya enmascarada y se vuelve a comprobar antes de guardarla.
    CREATE TABLE IF NOT EXISTS objecion_marketing (
      id BIGSERIAL PRIMARY KEY,
      llamada_id BIGINT NOT NULL REFERENCES netelip_calls(id) ON DELETE CASCADE,
      evaluacion_id BIGINT REFERENCES llamada_evaluacion(id) ON DELETE CASCADE,
      tipo_objecion TEXT NOT NULL CHECK (tipo_objecion IN ('precio','plazo','confianza','decisor','otra')),
      cita TEXT NOT NULL,
      idea_contenido TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS objecion_marketing_fecha ON objecion_marketing(creado_en DESC);
    CREATE INDEX IF NOT EXISTS objecion_marketing_tipo ON objecion_marketing(tipo_objecion, creado_en DESC);

    -- Rúbricas versionadas (869fpj8dm): una versión activa por rol. Cambiar el guion es publicar una versión
    -- nueva, sin desplegar. Un rol sin versión activa se evalúa con la rúbrica fija fase0-v1 (rubrica-v1.md).
    CREATE TABLE IF NOT EXISTS rubrica_version (
      id BIGSERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,                   -- «sdr-v1»: se copia en llamada_evaluacion.version_rubrica
      rol TEXT NOT NULL CHECK (rol IN ('sdr','closer_f2','closer_f3')),
      version INTEGER NOT NULL CHECK (version > 0),
      fuente TEXT NOT NULL,                          -- documento del que sale (guion, manual…)
      nota_apto SMALLINT NOT NULL DEFAULT 80 CHECK (nota_apto BETWEEN 1 AND 100),
      objetivo TEXT NOT NULL,
      criterios JSONB NOT NULL,                      -- [{paso, nombre, peso, descripcion}], pesos que suman 100
      errores_criticos JSONB NOT NULL,               -- [{codigo, nombre, descripcion}]
      reglas JSONB NOT NULL DEFAULT '[]',            -- reglas de puntuación en texto
      activo BOOLEAN NOT NULL DEFAULT FALSE,
      vigente_desde TIMESTAMPTZ,
      creado_por TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rol, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rubrica_version_activa ON rubrica_version(rol) WHERE activo;

    -- Versión con la que se evaluó, nota por paso, consentimiento y reevaluaciones bajo demanda.
    ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS rubrica_version_id BIGINT REFERENCES rubrica_version(id);
    ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS puntuacion_pasos JSONB;          -- [{paso, nombre, peso, aplica, puntos, comentario}]
    ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS sin_consentimiento BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS reevaluacion BOOLEAN NOT NULL DEFAULT FALSE; -- no se envía al comercial
    -- Antes: una evaluación por llamada. Ahora: una por llamada y versión, para que reevaluar añada filas sin pisar.
    ALTER TABLE llamada_evaluacion DROP CONSTRAINT IF EXISTS llamada_evaluacion_llamada_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS llamada_evaluacion_llamada_version ON llamada_evaluacion (llamada_id, (COALESCE(rubrica_version_id, 0)));
    CREATE INDEX IF NOT EXISTS llamada_evaluacion_llamada ON llamada_evaluacion (llamada_id, creado_en DESC);
  `);
}
