-- Reversión del calificador interno de llamadas: solo borra sus tablas. No toca netelip_*.
DROP TABLE IF EXISTS objecion_marketing;
DROP TABLE IF EXISTS llamada_feedback_humano;
DROP TABLE IF EXISTS llamada_evaluacion;
DROP TABLE IF EXISTS rubrica_version;
DROP TABLE IF EXISTS comercial_rol;

-- Solo las rúbricas versionadas (869fpj8dm), conservando las evaluaciones: ejecuta este bloque en lugar del anterior.
-- DELETE FROM llamada_evaluacion WHERE reevaluacion;
-- DROP INDEX IF EXISTS llamada_evaluacion_llamada_version;
-- ALTER TABLE llamada_evaluacion ADD CONSTRAINT llamada_evaluacion_llamada_id_key UNIQUE (llamada_id);
-- ALTER TABLE llamada_evaluacion DROP COLUMN IF EXISTS rubrica_version_id, DROP COLUMN IF EXISTS puntuacion_pasos,
--   DROP COLUMN IF EXISTS sin_consentimiento, DROP COLUMN IF EXISTS reevaluacion;
-- DROP TABLE IF EXISTS rubrica_version;
