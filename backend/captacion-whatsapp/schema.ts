// Esquema del aviso por WhatsApp de Captación (lead en «e1 EN ESPERA»). Solo tablas nuevas con prefijo captacion_;
// no toca crm_leads, ClickUp ni ninguna tabla existente. Idempotente: se aplica en cada arranque.
// Reversión: backend/captacion-whatsapp/schema-down.sql.
import type { Pool } from 'pg';

type Consultable = Pick<Pool, 'query'>;

export const ESTADOS_AVISO = ['pendiente', 'enviado', 'entregado', 'leido', 'fallido', 'no_enviado'] as const;
export type EstadoAviso = typeof ESTADOS_AVISO[number];

export async function ensureCaptacionWhatsApp(pool: Consultable): Promise<void> {
  await pool.query(`
    -- Bandeja durable de los webhooks de ClickUp: el receptor guarda y responde; el procesado (que consulta la tarea
    -- en ClickUp) va aparte, con reintentos.
    CREATE TABLE IF NOT EXISTS captacion_clickup_inbox (
      id BIGSERIAL PRIMARY KEY,
      payload JSONB NOT NULL,
      recibido_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','hecho','fallido')),
      intentos INTEGER NOT NULL DEFAULT 0,
      siguiente_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ultimo_error TEXT,
      procesado_en TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS captacion_clickup_inbox_pendientes ON captacion_clickup_inbox(siguiente_intento) WHERE estado = 'pendiente';

    -- Si cada lead (tarea padre de «Contacto de Reforma») está ahora en espera y desde cuándo. Es lo que separa
    -- una solicitud nueva (entra en e1) de la misma solicitud procesada otra vez (webhook repetido o el barrido).
    CREATE TABLE IF NOT EXISTS captacion_lead_espera (
      clickup_task_id TEXT PRIMARY KEY,
      en_espera BOOLEAN NOT NULL,
      solicitud TEXT,                          -- clave de la última entrada en e1 (la del aviso)
      cambio_en TIMESTAMPTZ NOT NULL,          -- fecha del último cambio aplicado (del webhook o del barrido)
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Interacción del lead: un aviso por solicitud, con su resultado. clickup_task_id es el identificador del lead
    -- que usan el resto de módulos (reuniones de Meet, esquema centralizado).
    CREATE TABLE IF NOT EXISTS captacion_whatsapp_avisos (
      id BIGSERIAL PRIMARY KEY,
      solicitud TEXT NOT NULL UNIQUE,          -- clickup:<task>:<history_item> o barrido:<task>:<epoch ms>
      clickup_task_id TEXT NOT NULL,
      origen TEXT NOT NULL CHECK (origen IN ('webhook','barrido')),
      entrada_en TIMESTAMPTZ NOT NULL,         -- cuándo entró en e1 (o cuándo lo vio el barrido)
      lead_nombre TEXT,
      telefono_original TEXT,                  -- tal como está en ClickUp
      telefono_e164 TEXT,                      -- NULL si falta o no es válido
      estado TEXT NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente','enviado','entregado','leido','fallido','no_enviado')),
      motivo TEXT,                             -- por qué no se envió o falló (código y texto)
      plantilla TEXT,
      wamid TEXT UNIQUE,                       -- id del mensaje en la Cloud API
      intentos INTEGER NOT NULL DEFAULT 0,
      siguiente_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviado_en TIMESTAMPTZ,
      entregado_en TIMESTAMPTZ,
      leido_en TIMESTAMPTZ,
      fallido_en TIMESTAMPTZ,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS captacion_whatsapp_avisos_pendientes ON captacion_whatsapp_avisos(siguiente_intento) WHERE estado = 'pendiente';
    CREATE INDEX IF NOT EXISTS captacion_whatsapp_avisos_lead ON captacion_whatsapp_avisos(clickup_task_id, creado_en DESC);

    -- Línea base: el primer barrido marca los leads que YA estaban en e1 al activar el módulo, sin escribirles.
    CREATE TABLE IF NOT EXISTS captacion_estado (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      linea_base_en TIMESTAMPTZ,
      ultimo_barrido_en TIMESTAMPTZ
    );
    INSERT INTO captacion_estado (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
  `);
}
