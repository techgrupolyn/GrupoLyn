-- Reversión del aviso por WhatsApp de Captación (lead en «e1 EN ESPERA»). Solo borra las tablas captacion_*.
-- Antes: CAPTACION_WHATSAPP_ENABLED=false (o revertir el código); si no, el siguiente arranque las vuelve a crear.
-- Borrar el webhook de ClickUp aparte (DELETE /api/v2/webhook/{id}): sin el backend, ClickUp lo desactiva solo tras fallos.
DROP TABLE IF EXISTS captacion_whatsapp_avisos;
DROP TABLE IF EXISTS captacion_lead_espera;
DROP TABLE IF EXISTS captacion_clickup_inbox;
DROP TABLE IF EXISTS captacion_estado;
