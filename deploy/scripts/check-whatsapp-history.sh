#!/usr/bin/env bash
set -Eeuo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Ejecuta con sudo.' >&2; exit 1; }
echo 'Diagnóstico de solo lectura para todas las cuentas; no envía mensajes ni confirmaciones de lectura.'
echo 'Configuración del servicio Evolution:'
grep -E '^DATABASE_SAVE_DATA_(HISTORIC|NEW_MESSAGE)=' /etc/lyn/evolution.env || true
echo 'Cuentas del dashboard y sus instancias:'
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -P pager=off -d superagente <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT id AS cuenta, nombre, evolution_instance_name AS instancia, activo
FROM whatsapp_accounts ORDER BY id;

SELECT c.account_id AS cuenta,
       COUNT(*) AS grupos_con_pendientes,
       SUM(c.unread_count) AS pendientes_del_contador,
       COUNT(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM mensajes m
         WHERE m.account_id = c.account_id AND m.chat_id = c.id AND m.enviado_por_mi = FALSE
       )) AS grupos_sin_contenido_entrante
FROM chats c
WHERE c.unread_count > 0 AND c.id LIKE '%@g.us'
GROUP BY c.account_id ORDER BY c.account_id;

SELECT account_id AS cuenta,state AS estado,checked_at AS comprobado,
       jsonb_array_length(COALESCE(details->'gaps','[]'::jsonb)) AS grupos_con_incidencia,
       details->'recovery' AS recuperacion
FROM whatsapp_sync_health ORDER BY account_id;

SELECT account_id AS cuenta,COUNT(*) AS recepciones_pendientes,
       COUNT(*) FILTER(WHERE attempts>0) AS con_reintentos,
       MAX(attempts) AS maximo_intentos,MIN(created_at) AS pendiente_desde
FROM whatsapp_message_inbox GROUP BY account_id ORDER BY account_id;
COMMIT;
SQL
echo 'Estado e historial almacenado por instancia Evolution (no equivale a textos pendientes):'
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -P pager=off -d evolution_db <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT i.name AS instancia, i."connectionStatus" AS conexion,
       s."syncFullHistory" AS historial_completo_configurado,
       s."readMessages" AS lectura_automatica,
       COALESCE(h.mensajes, 0) AS mensajes_entrantes_de_grupos,
       COALESCE(h.grupos, 0) AS grupos_con_contenido
FROM evolution_api."Instance" i
LEFT JOIN evolution_api."Setting" s ON s."instanceId" = i.id
LEFT JOIN (
  SELECT "instanceId", COUNT(*) AS mensajes, COUNT(DISTINCT key->>'remoteJid') AS grupos
  FROM evolution_api."Message"
  WHERE key->>'fromMe' = 'false' AND key->>'remoteJid' LIKE '%@g.us'
  GROUP BY "instanceId"
) h ON h."instanceId" = i.id
ORDER BY i.name;
COMMIT;
SQL
echo 'Estos conteos no certifican cobertura completa. Un historial ausente no se reconstruye activando su persistencia.'
