SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensajes_phone_evidence_v1
ON public.mensajes (
  account_id,
  public.lyn_phone_evidence_sender_v1(remitente_jid, raw),
  timestamp DESC,
  chat_id,
  id
)
WHERE enviado_por_mi = FALSE
  AND source = 'evolution'
  AND (
    (LOWER(COALESCE(tipo, 'text')) = 'text' AND BTRIM(COALESCE(texto, '')) <> '')
    OR LOWER(tipo) IN ('image', 'video', 'audio', 'document', 'sticker', 'contact')
  );

RESET lock_timeout;
RESET statement_timeout;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = to_regclass('idx_mensajes_phone_evidence_v1')
      AND indrelid = to_regclass('mensajes')
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Phone evidence index is missing or invalid; keep integration disabled';
  END IF;
END;
$$;
