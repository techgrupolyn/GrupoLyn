// Esquema de llamadas de Netelip y WhatsApp. Solo cambios aditivos: tablas nuevas con prefijo
// netelip_ y claves foráneas ON DELETE SET NULL hacia clientes, crm_leads y empleados, que no
// cambian el comportamiento de esas tablas. Idempotente: se aplica en cada arranque.
// Reversión: backend/netelip/schema-down.sql (solo borra las tablas netelip_*).
import type { Pool } from 'pg';

export const NETELIP_TABLES = [
  'netelip_audio_deletion_requests', 'netelip_call_reports', 'netelip_call_transcriptions',
  'netelip_calls', 'netelip_inbox', 'netelip_extensions',
] as const;

export async function ensureNetelipCalls(pool: Pool): Promise<void> {
  await pool.query(`
    -- Bandeja durable del receptor: el webhook guarda y responde; el procesado va aparte.
    -- payload lleva la URLDownload (con token de vDrive) hasta procesarse; después se elimina.
    CREATE TABLE IF NOT EXISTS netelip_inbox (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('callrecording','report','whatsapp_call')),
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT,
      processed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS netelip_inbox_pending ON netelip_inbox(next_attempt_at) WHERE status='pending';

    -- Extensión de la centralita → miembro del equipo. Sin fila, la vista muestra la extensión.
    CREATE TABLE IF NOT EXISTS netelip_extensions (
      extension TEXT PRIMARY KEY,
      empleado_id VARCHAR(255) REFERENCES empleados(id) ON DELETE SET NULL,
      label TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS netelip_calls (
      id BIGSERIAL PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,              -- uniqueid de Netelip, o wa:<wacid> de WhatsApp
      via TEXT NOT NULL DEFAULT 'phone' CHECK (via IN ('phone','whatsapp')),
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      occurred_at TIMESTAMPTZ NOT NULL,              -- inicio de la llamada, UTC
      started_at_source TEXT NOT NULL,               -- uniqueid | received_minus_duration | asterisk
      counterpart_phone TEXT NOT NULL,               -- valor recibido (p. ej. «anonymous» si es oculto)
      phone_e164 TEXT,                               -- NULL si es oculto o no normalizable
      counterpart_wa_user_id TEXT,                   -- BSUID de WhatsApp
      -- matched: vinculada a un lead o cliente · unknown: teléfono pendiente de resolución
      -- hidden: número oculto, sin contacto ni identidad pendiente · multiple: varias coincidencias
      contact_status TEXT NOT NULL CHECK (contact_status IN ('matched','unknown','hidden','multiple')),
      client_id VARCHAR(255) REFERENCES clientes(id) ON DELETE SET NULL,
      lead_id UUID REFERENCES crm_leads(id) ON DELETE SET NULL,
      agent_extension TEXT,
      duration_seconds INTEGER NOT NULL,
      call_status TEXT NOT NULL,
      audio_ref TEXT NOT NULL,                       -- ruta en vDrive o en Asterisk; NUNCA la URL con token
      received_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      linked_at TIMESTAMPTZ,
      CHECK (client_id IS NULL OR lead_id IS NULL)
    );
    CREATE INDEX IF NOT EXISTS netelip_calls_occurred ON netelip_calls(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS netelip_calls_phone ON netelip_calls(phone_e164);
    CREATE INDEX IF NOT EXISTS netelip_calls_client ON netelip_calls(client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS netelip_calls_lead ON netelip_calls(lead_id) WHERE lead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS netelip_calls_agent ON netelip_calls(agent_extension);

    CREATE TABLE IF NOT EXISTS netelip_call_transcriptions (
      call_id BIGINT PRIMARY KEY REFERENCES netelip_calls(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
      engine TEXT,
      language TEXT,
      text TEXT,                                     -- tal cual lo devuelve el motor; no se edita
      segments JSONB,                                -- [{speaker, start, end, text}] si el motor los entrega
      attempts SMALLINT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_url TEXT,                               -- URL de descarga temporal (token): se borra al terminar
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    -- Avance (0-100) mientras el motor transcribe, para la barra de progreso del Dashboard.
    ALTER TABLE netelip_call_transcriptions ADD COLUMN IF NOT EXISTS progress SMALLINT;
    CREATE INDEX IF NOT EXISTS netelip_call_transcriptions_queue ON netelip_call_transcriptions(next_attempt_at) WHERE status IN ('pending','processing');

    -- Informe periódico de llamadas de Netelip, para la conciliación.
    CREATE TABLE IF NOT EXISTS netelip_call_reports (
      report_key TEXT PRIMARY KEY,
      raw JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      reconciled_at TIMESTAMPTZ,
      reconcile_result TEXT CHECK (reconcile_result IN ('present','recovered','reported','skipped'))
    );
    CREATE INDEX IF NOT EXISTS netelip_call_reports_pending ON netelip_call_reports(received_at) WHERE reconciled_at IS NULL;

    -- Supresión y retención: el audio vive en vDrive y se borra allí.
    CREATE TABLE IF NOT EXISTS netelip_audio_deletion_requests (
      id BIGSERIAL PRIMARY KEY,
      call_id BIGINT REFERENCES netelip_calls(id) ON DELETE SET NULL,
      audio_ref TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK (reason IN ('erasure','retention')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at TIMESTAMPTZ
    );
  `);
}
