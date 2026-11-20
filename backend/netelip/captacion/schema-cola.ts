// Captación ABCD · cola de llamadas (N-1.2, reintentos y colas de errores y «sin lead»): una fila por llamada transcrita que hay que
// procesar. Tabla aditiva e idempotente, aplicada desde `ensureCaptacion`. No tiene claves foráneas hacia las tablas de Netelip (no se
// toca nada ajeno) y se borra con schema-down.sql.

export const COLA_TABLES = ['captacion_cola'] as const;

export async function ensureCola(pool: { query(sql: string): Promise<unknown> }): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS captacion_cola (
      llamada_id       TEXT         PRIMARY KEY,
      ocurrida_en      TIMESTAMPTZ  NOT NULL,
      estado           TEXT         NOT NULL DEFAULT 'pendiente',
      intentos         INTEGER      NOT NULL DEFAULT 0,
      sin_lead_veces   INTEGER      NOT NULL DEFAULT 0,
      proximo_intento  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      clickup_task_id  TEXT,
      motivo           TEXT,
      escritura        TEXT,
      escritura_detalle TEXT,
      creado_en        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      actualizado_en   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT captacion_cola_estado_ck
        CHECK (estado IN ('pendiente', 'procesando', 'procesada', 'sin_lead', 'sin_conversacion', 'error')),
      CONSTRAINT captacion_cola_escritura_ck
        CHECK (escritura IS NULL OR escritura IN ('escrita', 'simulada', 'no_vivo', 'error')),
      CONSTRAINT captacion_cola_intentos_ck CHECK (intentos >= 0 AND sin_lead_veces >= 0)
    );

    CREATE INDEX IF NOT EXISTS captacion_cola_turno_idx ON captacion_cola (estado, proximo_intento, ocurrida_en);
  `);
}
