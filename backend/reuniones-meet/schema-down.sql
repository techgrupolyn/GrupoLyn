-- Reversión de las reuniones de Meet del calificador interno (869fppbcj).
-- Quita el FK que este módulo añade a llamada_evaluacion (la columna reunion_id y su CHECK son de Juan y se quedan)
-- y borra la tabla reunion. No toca google_drive_*, meeting_* ni comercial_rol.
-- Si ya hay evaluaciones de reuniones, antes hay que decidir qué hacer con ellas: sin el FK quedarían huérfanas.
ALTER TABLE IF EXISTS llamada_evaluacion DROP CONSTRAINT IF EXISTS llamada_evaluacion_reunion_fk;
DROP TABLE IF EXISTS reunion;
