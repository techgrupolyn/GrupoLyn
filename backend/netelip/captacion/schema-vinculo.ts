// Captación ABCD · N-1.0 (ticket 1an2gnq0c77): a qué lead de «Contacto de Reforma» pertenece cada llamada de Netelip. Tabla aditiva e
// idempotente, aplicada desde `ensureCaptacion`. No toca `netelip_calls` ni ninguna tabla ajena (el Dashboard la lee con un LEFT JOIN) y se
// borra con schema-down.sql. El cruce solo LEE ClickUp: nada de esto escribe en el tablero.

export const VINCULO_TABLES = ['captacion_llamada_lead'] as const;

export async function ensureVinculo(pool: { query(sql: string): Promise<unknown> }): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS captacion_llamada_lead (
      call_id          BIGINT       PRIMARY KEY,
      estado           TEXT         NOT NULL,
      clickup_task_id  TEXT,
      lead_nombre      TEXT,
      via              TEXT,
      origen           TEXT         NOT NULL DEFAULT 'automatico',
      -- Con varias coincidencias: las tarjetas entre las que hay que elegir a mano, como [{"id": "...", "nombre": "..."}].
      candidatos       JSONB        NOT NULL DEFAULT '[]'::jsonb,
      asignada_por     TEXT,
      creado_en        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      actualizado_en   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT captacion_llamada_lead_estado_ck
        CHECK (estado IN ('vinculada', 'varias_coincidencias', 'sin_coincidencia', 'sin_datos')),
      CONSTRAINT captacion_llamada_lead_via_ck CHECK (via IS NULL OR via IN ('telefono', 'email', 'manual')),
      CONSTRAINT captacion_llamada_lead_origen_ck CHECK (origen IN ('automatico', 'manual')),
      CONSTRAINT captacion_llamada_lead_vinculo_ck
        CHECK ((estado = 'vinculada') = (clickup_task_id IS NOT NULL AND via IS NOT NULL)),
      CONSTRAINT captacion_llamada_lead_manual_ck
        CHECK ((origen = 'manual') = (via = 'manual'))
    );

    CREATE INDEX IF NOT EXISTS captacion_llamada_lead_estado_idx ON captacion_llamada_lead (estado);
    CREATE INDEX IF NOT EXISTS captacion_llamada_lead_tarea_idx ON captacion_llamada_lead (clickup_task_id) WHERE clickup_task_id IS NOT NULL;
  `);
}
