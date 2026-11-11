-- Reversión de las reuniones de Meet del calificador interno (869fppbcj): solo borra su tabla.
-- No toca google_drive_*, meeting_*, comercial_rol ni llamada_evaluacion.
DROP TABLE IF EXISTS reunion;
