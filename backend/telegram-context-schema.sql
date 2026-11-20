BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS public.telegram_ai_egress(
 id uuid PRIMARY KEY,scope_hash char(64) NOT NULL,provider text NOT NULL,model text NOT NULL,
 payload jsonb NOT NULL,payload_sha256 char(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.telegram_agent_runs(
 id uuid PRIMARY KEY,chat_id varchar(255) NOT NULL REFERENCES public.chats(id),proyecto_id varchar(255) NOT NULL REFERENCES public.proyectos(id),
 specialist_id text NOT NULL,source text NOT NULL CHECK(source='Telegram'),output text NOT NULL,provider text NOT NULL,model text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.telegram_agent_runs ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;
REVOKE ALL ON public.telegram_ai_egress,public.telegram_agent_runs FROM PUBLIC;
ALTER TABLE public.telegram_ai_egress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_agent_runs ENABLE ROW LEVEL SECURITY;
COMMIT;
