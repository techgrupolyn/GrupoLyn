CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id VARCHAR(120) PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  evolution_instance_name VARCHAR(120) NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_members (
  account_id VARCHAR(120) NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  empleado_id VARCHAR(255) NOT NULL,
  rol VARCHAR(50) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, empleado_id)
);
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS chats (
  id         VARCHAR(255) PRIMARY KEY,
  nombre     VARCHAR(255) NOT NULL DEFAULT 'Sin nombre',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS es_cliente BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS whatsapp_unread_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS reviewed_unread_baseline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS profile_picture_url VARCHAR(255);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_chats_account_updated ON chats(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mensajes (
  id              VARCHAR(255) PRIMARY KEY,
  chat_id         VARCHAR(255) NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  remitente       VARCHAR(255) NOT NULL,
  texto           TEXT         NOT NULL,
  timestamp       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  enviado_por_mi  BOOLEAN      NOT NULL DEFAULT FALSE,
  remitente_jid   VARCHAR(255),
  tipo            VARCHAR(40)  NOT NULL DEFAULT 'text',
  media           JSONB,
  raw             JSONB,
  source          VARCHAR(20)  NOT NULL DEFAULT 'evolution',
  estado          VARCHAR(20)  NOT NULL DEFAULT 'pendiente',
  reacciones      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  etiquetas       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  edited          BOOLEAN      NOT NULL DEFAULT FALSE
);

ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_mensajes_account_chat_timestamp ON mensajes(account_id, chat_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS grupos (
  id         VARCHAR(255) PRIMARY KEY,
  nombre     VARCHAR(255) NOT NULL DEFAULT 'Sin nombre',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source     VARCHAR(20)  NOT NULL DEFAULT 'evolution'
);

ALTER TABLE grupos ADD COLUMN IF NOT EXISTS group_metadata JSONB;
ALTER TABLE grupos ADD COLUMN IF NOT EXISTS owner_jid VARCHAR(255);
ALTER TABLE grupos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE grupos ADD COLUMN IF NOT EXISTS profile_picture_url VARCHAR(255);

CREATE TABLE IF NOT EXISTS analisis_ia (
  id               SERIAL PRIMARY KEY,
  mensaje_id       VARCHAR(255) NOT NULL,
  grupo_id         VARCHAR(255) NOT NULL,
  rol_requerido    VARCHAR(120) NOT NULL DEFAULT 'General',
  necesita_accion  BOOLEAN      NOT NULL DEFAULT FALSE,
  urgencia         VARCHAR(40)  NOT NULL DEFAULT 'media',
  confianza        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  prompt_utilizado TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE analisis_ia ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
CREATE UNIQUE INDEX IF NOT EXISTS idx_analisis_ia_mensaje_id ON analisis_ia(mensaje_id);

CREATE TABLE IF NOT EXISTS resumenes_chat (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  especialista_id VARCHAR(120) NOT NULL DEFAULT 'general',
  resumen TEXT NOT NULL,
  mensaje_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  mensajes_contexto INTEGER NOT NULL DEFAULT 0,
  periodo_inicio TIMESTAMPTZ,
  periodo_fin TIMESTAMPTZ,
  ai_provider VARCHAR(40) NOT NULL DEFAULT 'unknown',
  ai_model VARCHAR(120) NOT NULL DEFAULT 'unknown',
  ai_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS respuestas_chat (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  especialista_id VARCHAR(120) NOT NULL DEFAULT 'general',
  respuesta TEXT NOT NULL,
  mensaje_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  mensajes_contexto INTEGER NOT NULL DEFAULT 0,
  resumen_id INTEGER,
  resumen_especialista_id VARCHAR(120),
  origen VARCHAR(40) NOT NULL DEFAULT 'manual',
  mensaje_enviado_id VARCHAR(255),
  enviada BOOLEAN NOT NULL DEFAULT FALSE,
  enviada_at TIMESTAMPTZ,
  ai_provider VARCHAR(40) NOT NULL DEFAULT 'unknown',
  ai_model VARCHAR(120) NOT NULL DEFAULT 'unknown',
  ai_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ceo_consultas (
  id SERIAL PRIMARY KEY,
  pregunta TEXT NOT NULL,
  respuesta TEXT NOT NULL,
  mensajes_contexto INTEGER NOT NULL DEFAULT 0,
  resumenes_contexto INTEGER NOT NULL DEFAULT 0,
  respuestas_contexto INTEGER NOT NULL DEFAULT 0,
  periodo_inicio TIMESTAMPTZ,
  periodo_fin TIMESTAMPTZ,
  fuentes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_provider VARCHAR(40) NOT NULL DEFAULT 'unknown',
  ai_model VARCHAR(120) NOT NULL DEFAULT 'unknown',
  ai_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS especialistas (
  id VARCHAR(120) PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  rol VARCHAR(120) NOT NULL DEFAULT 'general',
  sistema_prompt TEXT NOT NULL DEFAULT '',
  modelo VARCHAR(40) NOT NULL DEFAULT 'flash',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS etiquetas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  color VARCHAR(20) DEFAULT '#6366f1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plantillas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  lenguaje VARCHAR(10) DEFAULT 'es',
  componentes JSONB,
  tipo VARCHAR(20) DEFAULT 'template',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id          VARCHAR(255) PRIMARY KEY,
  nombre      VARCHAR(255) NOT NULL,
  descripcion TEXT
);

CREATE TABLE IF NOT EXISTS empleados (
  id       VARCHAR(255) PRIMARY KEY,
  nombre   VARCHAR(255) NOT NULL,
  apellido VARCHAR(255),
  empresa  VARCHAR(255),
  numero   VARCHAR(255) UNIQUE NOT NULL,
  activo   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS usuario_rol (
  empleado_id VARCHAR(255) NOT NULL,
  rol_id      VARCHAR(255) NOT NULL,
  PRIMARY KEY (empleado_id, rol_id)
);

CREATE TABLE IF NOT EXISTS chat_participantes (
  chat_id    VARCHAR(255) NOT NULL,
  user_id    VARCHAR(255) NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS grupo_participantes (
  id SERIAL PRIMARY KEY,
  grupo_id VARCHAR(255) NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  remote_jid VARCHAR(255) NOT NULL,
  participant_jid VARCHAR(255),
  role VARCHAR(20) DEFAULT 'member',
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(grupo_id, remote_jid)
);

CREATE TABLE IF NOT EXISTS proyectos (
  id          VARCHAR(255) PRIMARY KEY,
  nombre      VARCHAR(255) NOT NULL,
  descripcion TEXT
);

CREATE TABLE IF NOT EXISTS mensaje_usuario (
  mensaje_id VARCHAR(255) NOT NULL REFERENCES mensajes(id) ON DELETE CASCADE,
  usuario_id VARCHAR(255) NOT NULL,
  leido      BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (mensaje_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS auditoria_respuestas (
  id                SERIAL PRIMARY KEY,
  mensaje_id        VARCHAR(255) NOT NULL,
  chat_id           VARCHAR(255) NOT NULL,
  usuario_id        VARCHAR(255) NOT NULL,
  rol_respuesta     VARCHAR(255) NOT NULL,
  roles_apoyo       TEXT[],
  propuesta_ia      TEXT,
  propuesta_original TEXT,
  respuesta_final   TEXT,
  roles_aplicados TEXT[],
  cambios_usuario TEXT,
  usuario_aprueba VARCHAR(255),
  propuesta_modificada BOOLEAN NOT NULL DEFAULT FALSE,
  enviado           BOOLEAN NOT NULL DEFAULT FALSE,
  estado_asunto     VARCHAR(40) NOT NULL DEFAULT 'pendiente',
  estado_manual BOOLEAN NOT NULL DEFAULT FALSE,
  respuesta_automatica BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_at        TIMESTAMPTZ
);
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS propuesta_original TEXT;
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS roles_aplicados TEXT[];
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS cambios_usuario TEXT;
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS usuario_aprueba VARCHAR(255);
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS estado_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE auditoria_respuestas ADD COLUMN IF NOT EXISTS respuesta_automatica BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_auditoria_respuestas_mensaje_usuario ON auditoria_respuestas(mensaje_id, usuario_id);

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  usuario VARCHAR(100) UNIQUE NOT NULL,
  contraseña VARCHAR(255) NOT NULL DEFAULT '',
  password_hash VARCHAR(255),
  nombre VARCHAR(255),
  rol VARCHAR(50) DEFAULT 'admin',
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

CREATE TABLE IF NOT EXISTS extension_invitations (
  id UUID PRIMARY KEY,
  label VARCHAR(160),
  code_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_extension_invitations_active ON extension_invitations(expires_at) WHERE redeemed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE extension_invitations ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_extension_invitations_account ON extension_invitations(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS extension_activations (
  id UUID PRIMARY KEY,
  invitation_id UUID NOT NULL REFERENCES extension_invitations(id) ON DELETE RESTRICT,
  label VARCHAR(160),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_extension_activations_invitation ON extension_activations(invitation_id);
ALTER TABLE extension_activations ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
ALTER TABLE resumenes_chat ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
ALTER TABLE respuestas_chat ADD COLUMN IF NOT EXISTS account_id VARCHAR(120) NOT NULL DEFAULT 'default';
ALTER TABLE ceo_consultas ADD COLUMN IF NOT EXISTS account_id VARCHAR(120);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS proyecto_id VARCHAR(255) REFERENCES proyectos(id);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS participantes JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_mensajes_chat_id   ON mensajes(chat_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_timestamp ON mensajes(timestamp);
CREATE INDEX IF NOT EXISTS idx_grupos_source      ON grupos(source);
CREATE INDEX IF NOT EXISTS idx_mensajes_source    ON mensajes(source);
CREATE INDEX IF NOT EXISTS idx_analisis_ia_grupo  ON analisis_ia(grupo_id);
CREATE INDEX IF NOT EXISTS idx_mensaje_usuario_usuario ON mensaje_usuario(usuario_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_chat ON auditoria_respuestas(chat_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria_respuestas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_chat_timestamp ON mensajes(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_resumenes_chat_created_at ON resumenes_chat(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_respuestas_chat_created_at ON respuestas_chat(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_respuestas_chat_especialista_created ON respuestas_chat(especialista_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_respuestas_chat_mensaje_enviado ON respuestas_chat(mensaje_enviado_id) WHERE mensaje_enviado_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ceo_consultas_created_at ON ceo_consultas(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analisis_ia_mensaje_id_fkey') THEN
    ALTER TABLE analisis_ia ADD CONSTRAINT analisis_ia_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES mensajes(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resumenes_chat_chat_id_fkey') THEN
    ALTER TABLE resumenes_chat ADD CONSTRAINT resumenes_chat_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resumenes_chat_especialista_id_fkey') THEN
    ALTER TABLE resumenes_chat ADD CONSTRAINT resumenes_chat_especialista_id_fkey FOREIGN KEY (especialista_id) REFERENCES especialistas(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'respuestas_chat_chat_id_fkey') THEN
    ALTER TABLE respuestas_chat ADD CONSTRAINT respuestas_chat_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'respuestas_chat_especialista_id_fkey') THEN
    ALTER TABLE respuestas_chat ADD CONSTRAINT respuestas_chat_especialista_id_fkey FOREIGN KEY (especialista_id) REFERENCES especialistas(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'respuestas_chat_resumen_id_fkey') THEN
    ALTER TABLE respuestas_chat ADD CONSTRAINT respuestas_chat_resumen_id_fkey FOREIGN KEY (resumen_id) REFERENCES resumenes_chat(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'respuestas_chat_mensaje_enviado_id_fkey') THEN
    ALTER TABLE respuestas_chat ADD CONSTRAINT respuestas_chat_mensaje_enviado_id_fkey FOREIGN KEY (mensaje_enviado_id) REFERENCES mensajes(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION insert_mensaje_idempotente(
  p_id        VARCHAR(255),
  p_chat_id   VARCHAR(255),
  p_remitente VARCHAR(255),
  p_texto     TEXT,
  p_timestamp TIMESTAMPTZ DEFAULT NOW()
) RETURNS VOID AS $$
BEGIN
  INSERT INTO chats (id, nombre, updated_at)
  VALUES (p_chat_id, p_remitente, p_timestamp)
  ON CONFLICT (id) DO UPDATE
    SET updated_at = EXCLUDED.updated_at,
        nombre     = CASE
                      WHEN chats.nombre = 'Sin nombre' THEN EXCLUDED.nombre
                      ELSE chats.nombre
                    END;

  INSERT INTO mensajes (id, chat_id, remitente, texto, timestamp)
  VALUES (p_id, p_chat_id, p_remitente, p_texto, p_timestamp)
  ON CONFLICT (id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS google_drive_connections (
  id UUID PRIMARY KEY,
  google_email VARCHAR(320) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  created_by VARCHAR(120) NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_drive_connections_active ON google_drive_connections(created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS google_drive_folders (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES google_drive_connections(id) ON DELETE CASCADE,
  google_folder_id VARCHAR(255) NOT NULL,
  label VARCHAR(255) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id, google_folder_id)
);
CREATE INDEX IF NOT EXISTS idx_google_drive_folders_connection ON google_drive_folders(connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS google_drive_artifacts (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES google_drive_connections(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES google_drive_folders(id) ON DELETE SET NULL,
  google_file_id VARCHAR(255) NOT NULL,
  name VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  artifact_type VARCHAR(40) NOT NULL,
  web_view_link TEXT,
  source_modified_at TIMESTAMPTZ,
  size_bytes BIGINT,
  checksum VARCHAR(255),
  content_text TEXT,
  content_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id, google_file_id)
);
CREATE INDEX IF NOT EXISTS idx_google_drive_artifacts_folder_updated ON google_drive_artifacts(folder_id, source_modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_google_drive_artifacts_type ON google_drive_artifacts(artifact_type, source_modified_at DESC);

CREATE TABLE IF NOT EXISTS meeting_reviews (
  artifact_id UUID PRIMARY KEY REFERENCES google_drive_artifacts(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  project_name VARCHAR(255),
  contact_name VARCHAR(255),
  meeting_kind VARCHAR(80) NOT NULL DEFAULT 'MEET',
  pmc VARCHAR(255),
  workflow_stage VARCHAR(40) NOT NULL DEFAULT 'agent',
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMPTZ,
  approved_by VARCHAR(120),
  returned_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_reviews_status ON meeting_reviews(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS meeting_review_actions (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES meeting_reviews(artifact_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  project_name VARCHAR(255),
  responsible VARCHAR(255),
  due_date DATE,
  estimated_minutes INTEGER,
  source_ref VARCHAR(1024),
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_review_actions_artifact ON meeting_review_actions(artifact_id, created_at ASC);
CREATE TABLE IF NOT EXISTS meeting_review_versions (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES meeting_reviews(artifact_id) ON DELETE CASCADE,
  actor VARCHAR(120) NOT NULL,
  stage VARCHAR(80) NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_review_versions_artifact ON meeting_review_versions(artifact_id, created_at DESC);
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS analysis_status VARCHAR(40) NOT NULL DEFAULT 'pending';
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS analysis_source_modified_at TIMESTAMPTZ;
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS analysis_completed_at TIMESTAMPTZ;
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS analysis_error TEXT;
CREATE INDEX IF NOT EXISTS idx_meeting_reviews_analysis_queue ON meeting_reviews(analysis_status, updated_at ASC);
ALTER TABLE meeting_review_actions ADD COLUMN IF NOT EXISTS origin VARCHAR(40) NOT NULL DEFAULT 'manual';
CREATE TABLE IF NOT EXISTS meeting_review_blockers (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES meeting_reviews(artifact_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  source_ref VARCHAR(1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_review_blockers_artifact ON meeting_review_blockers(artifact_id, created_at DESC);
CREATE TABLE IF NOT EXISTS meeting_review_ai_runs (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES meeting_reviews(artifact_id) ON DELETE CASCADE,
  actor VARCHAR(120) NOT NULL,
  provider VARCHAR(80) NOT NULL,
  model VARCHAR(160) NOT NULL,
  input_chars INTEGER NOT NULL,
  output_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_review_ai_runs_artifact ON meeting_review_ai_runs(artifact_id, created_at DESC);
