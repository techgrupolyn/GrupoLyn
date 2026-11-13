-- Reversión del panel de marketing: solo borra sus tablas. No toca las del calificador ni las de Netelip.
DROP TABLE IF EXISTS mk_carga;
DROP TABLE IF EXISTS mk_zona_regla;
DROP TABLE IF EXISTS mk_familia_creativa;
DROP TABLE IF EXISTS mk_curva_maduracion;
DROP TABLE IF EXISTS mk_valor_letra;
DROP TABLE IF EXISTS mk_lead;
DROP TABLE IF EXISTS mk_gasto_diario;
