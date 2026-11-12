-- Reversión de las reuniones de Meet del calificador interno (869fppbcj). Ejecutar en este orden.
--
-- AVISO: los pasos 2 y 3 deshacen la migración de las tablas de Juan (migracion-calificador.ts). Solo funcionan si
-- no hay datos que dependan de ella: evaluaciones u objeciones de reuniones, o comerciales sin extensión o con
-- closer_f4. Si los hay, decidir antes qué hacer con ellos (cada paso falla sin borrar nada si encuentra uno).
-- Revertir también el código de los commits: sin él, el siguiente arranque vuelve a aplicar la migración.

-- 1 · Reuniones: el FK hacia reunion y la propia tabla.
ALTER TABLE IF EXISTS llamada_evaluacion DROP CONSTRAINT IF EXISTS llamada_evaluacion_reunion_fk;

-- 2 · llamada_evaluacion y objecion_marketing vuelven a exigir una llamada.
ALTER TABLE IF EXISTS objecion_marketing DROP CONSTRAINT IF EXISTS objecion_marketing_origen_check;
ALTER TABLE IF EXISTS objecion_marketing ALTER COLUMN llamada_id SET NOT NULL;
DROP INDEX IF EXISTS llamada_evaluacion_reunion_version;
ALTER TABLE IF EXISTS llamada_evaluacion DROP CONSTRAINT IF EXISTS llamada_evaluacion_origen_check;
ALTER TABLE IF EXISTS llamada_evaluacion DROP COLUMN IF EXISTS reunion_id;
ALTER TABLE IF EXISTS llamada_evaluacion ALTER COLUMN llamada_id SET NOT NULL,
  ALTER COLUMN extension_netelip SET NOT NULL, ALTER COLUMN rol SET NOT NULL;

-- 3 · comercial_rol vuelve a tener la extensión como clave y tres roles.
ALTER TABLE IF EXISTS comercial_rol DROP CONSTRAINT IF EXISTS comercial_rol_empleado_id_key;
ALTER TABLE IF EXISTS comercial_rol DROP CONSTRAINT IF EXISTS comercial_rol_rol_check;
ALTER TABLE IF EXISTS comercial_rol ADD CONSTRAINT comercial_rol_rol_check CHECK (rol IN ('sdr','closer_f2','closer_f3'));
ALTER TABLE IF EXISTS comercial_rol DROP CONSTRAINT IF EXISTS comercial_rol_pkey;
ALTER TABLE IF EXISTS comercial_rol DROP CONSTRAINT IF EXISTS comercial_rol_extension_netelip_key;
ALTER TABLE IF EXISTS comercial_rol ADD CONSTRAINT comercial_rol_pkey PRIMARY KEY (extension_netelip);
ALTER TABLE IF EXISTS comercial_rol DROP COLUMN IF EXISTS id;

-- 4 · La tabla de reuniones (no toca google_drive_*, meeting_* ni el resto del calificador).
DROP TABLE IF EXISTS reunion;
