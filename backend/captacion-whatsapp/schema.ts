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
    -- Remitente (13/11/2026): el aviso sale del número del comercial que llamará, según el presupuesto del lead.
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS presupuesto TEXT;           -- «Presupuesto formulario» al entrar en e1
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS remitente TEXT;             -- nombre: Ernesto, Victor…
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS remitente_numero_id TEXT;   -- phone_number_id del que salió
    -- Jean (17/11/2026): el aviso sale del número general y anuncia el fijo de Netelip desde el que llamará el comercial.
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS telefono_anunciado TEXT;    -- fijo anunciado al lead
    -- Jean (19/11/2026): el número general no lo ve nadie, así que el comercial recibe en su WhatsApp una copia de cada
    -- aviso enviado (a quién y a qué teléfono). copia_estado NULL = sin copia configurada.
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_destino TEXT;         -- WhatsApp del comercial (E.164)
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_estado TEXT
      CHECK (copia_estado IN ('pendiente','enviada','fallida'));
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_intentos INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_siguiente_intento TIMESTAMPTZ;
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_wamid TEXT;
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_enviada_en TIMESTAMPTZ;
    ALTER TABLE captacion_whatsapp_avisos ADD COLUMN IF NOT EXISTS copia_motivo TEXT;
    CREATE INDEX IF NOT EXISTS captacion_whatsapp_avisos_pendientes ON captacion_whatsapp_avisos(siguiente_intento) WHERE estado = 'pendiente';
    CREATE INDEX IF NOT EXISTS captacion_whatsapp_avisos_copias ON captacion_whatsapp_avisos(copia_siguiente_intento) WHERE copia_estado = 'pendiente';
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
