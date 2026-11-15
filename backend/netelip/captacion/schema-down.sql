-- Reversión de la captación ABCD (N-1.1 y N-1.2): solo borra sus tablas. No toca netelip_* ni el calificador.
-- AVISO: borra el histórico de presupuestos y calificaciones, la configuración de la matriz, las
-- evaluaciones por criterio y los eventos de No apto. Solo para entornos de prueba o si no llegó a usarse.
-- Orden inverso al de creación; se puede aplicar más de una vez.
DROP TABLE IF EXISTS lead_no_apto_evento;
DROP TABLE IF EXISTS lead_criterio_evaluacion;
DROP TABLE IF EXISTS agregacion_config;
DROP TABLE IF EXISTS criterio_config;
DROP TABLE IF EXISTS lead_calificacion_historial;
DROP TABLE IF EXISTS lead_presupuesto_evento;
DROP TABLE IF EXISTS categoria_config;
