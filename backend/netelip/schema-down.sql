-- Reversión del esquema de llamadas (backend/netelip/schema.ts). Solo borra las tablas netelip_*:
-- no toca clientes, crm_leads, empleados ni ninguna tabla de WhatsApp o del Agente de Reuniones.
-- ATENCIÓN: borra las llamadas y transcripciones guardadas. Hacer copia antes en producción.
BEGIN;
DROP TABLE IF EXISTS netelip_audio_deletion_requests;
DROP TABLE IF EXISTS netelip_call_reports;
DROP TABLE IF EXISTS netelip_call_transcriptions;
DROP TABLE IF EXISTS netelip_calls;
DROP TABLE IF EXISTS netelip_inbox;
DROP TABLE IF EXISTS netelip_extensions;
COMMIT;
