BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.lyn_phone_evidence_sender_v1(sender_jid text, envelope jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN COALESCE(envelope #>> '{key,fromMe}', 'false') <> 'false' THEN NULL
    ELSE (
      SELECT CASE WHEN cardinality(phones) = 1 THEN phones[1] ELSE NULL END
      FROM (
        SELECT ARRAY(
          SELECT DISTINCT regexp_replace(split_part(candidate, '@', 1), ':[0-9]+$', '')
          FROM unnest(ARRAY[
            sender_jid,
            envelope ->> 'participantJid',
            envelope #>> '{key,participant}',
            envelope #>> '{key,participantJid}',
            envelope #>> '{key,participantAlt}'
          ]) AS candidates(candidate)
          WHERE candidate ~ '^[1-9][0-9]{7,14}(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
        ) AS phones
      ) normalized
    )
  END
$function$;

COMMIT;
