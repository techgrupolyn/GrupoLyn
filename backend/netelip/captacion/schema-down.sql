-- Reversión de la captación ABCD (N-1.1 a N-1.4): solo borra sus tablas. No toca netelip_* ni el calificador.
-- AVISO: borra el histórico de presupuestos y calificaciones, la configuración de la matriz, las
-- evaluaciones por criterio, los eventos de No apto, el histórico de resúmenes ejecutivos y todas las decisiones de pase
-- (propuestas del SDR, decisiones de la IA y revisiones de Ernesto) con su configuración. Solo para entornos de prueba o si no
-- llegó a usarse.
-- Orden inverso al de creación; se puede aplicar más de una vez. La cola de llamadas por procesar también se borra.
DROP TABLE IF EXISTS captacion_cola;
DROP TABLE IF EXISTS validacion_decision;
DROP TABLE IF EXISTS decision_lead;
DROP TABLE IF EXISTS decision_contexto_config;
DROP TABLE IF EXISTS decision_motivo_config;
DROP TABLE IF EXISTS lead_resumen_historial;
DROP TABLE IF EXISTS lead_no_apto_evento;
DROP TABLE IF EXISTS lead_criterio_evaluacion;
DROP TABLE IF EXISTS agregacion_config;
DROP TABLE IF EXISTS criterio_config;
DROP TABLE IF EXISTS lead_calificacion_historial;
DROP TABLE IF EXISTS lead_presupuesto_evento;
DROP TABLE IF EXISTS categoria_config;
