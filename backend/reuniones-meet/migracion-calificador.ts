// Migración aditiva de las tablas del calificador de llamadas para que admitan reuniones de Meet (869fppbcj).
// Acordada con Juan el 11/11/2026: la hace este módulo y él la revisa antes de pasar a main.
//
//   llamada_evaluacion   + reunion_id (BIGINT, FK en schema.ts › enlazarEvaluaciones)
//                        llamada_id, extension_netelip y rol admiten nulos (una reunión no tiene llamada ni extensión)
//                        CHECK num_nonnulls(llamada_id, reunion_id) = 1   (exactamente uno de los dos)
//                        una evaluación por reunión y versión: (reunion_id, COALESCE(rubrica_version_id, 0)), como las llamadas
//   rubrica_version      CHECK de rol con closer_f4 (la tabla la crea 869fpj8dm, PR #33)
//   objecion_marketing   llamada_id admite nulos; CHECK: al menos llamada_id o evaluacion_id (no hay objeciones huérfanas)
//   comercial_rol        id propio como clave; extension_netelip opcional pero UNIQUE (la cola, el envío y el alta
//                        hacen ON CONFLICT (extension_netelip)); empleado_id UNIQUE (una fila por persona); closer_f4
//
// Todo va en un único bloque DO: o se aplica entero o no se aplica nada. Se ejecuta en cada arranque y cada paso
// comprueba antes si ya está hecho (idempotente). Si una tabla no existe, ese paso se salta.
// Reversión: schema-down.sql (con sus avisos: algunos pasos solo se pueden deshacer si no hay datos nuevos).
import type { Pool } from 'pg';

type Consultable = Pick<Pool, 'query'>;

export const ROLES_CON_F4 = ['sdr', 'closer_f2', 'closer_f3', 'closer_f4'] as const;

export async function adaptarCalificador(pool: Consultable): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE
      c RECORD;
      col TEXT;
    BEGIN
      -- llamada_evaluacion ------------------------------------------------------------------------------
      IF to_regclass('llamada_evaluacion') IS NOT NULL THEN
        ALTER TABLE llamada_evaluacion ADD COLUMN IF NOT EXISTS reunion_id BIGINT;
        FOREACH col IN ARRAY ARRAY['llamada_id', 'extension_netelip', 'rol'] LOOP
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'llamada_evaluacion' AND column_name = col AND is_nullable = 'NO') THEN
            EXECUTE format('ALTER TABLE llamada_evaluacion ALTER COLUMN %I DROP NOT NULL', col);
          END IF;
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llamada_evaluacion_origen_check' AND conrelid = to_regclass('llamada_evaluacion')) THEN
          ALTER TABLE llamada_evaluacion ADD CONSTRAINT llamada_evaluacion_origen_check CHECK (num_nonnulls(llamada_id, reunion_id) = 1);
        END IF;
        -- Una evaluación por reunión y versión, con el mismo patrón que las llamadas (869fpj8dm:
        -- (llamada_id, COALESCE(rubrica_version_id, 0))). Sustituye al índice por version_rubrica del primer borrador.
        DROP INDEX IF EXISTS llamada_evaluacion_reunion_version;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                     AND table_name = 'llamada_evaluacion' AND column_name = 'rubrica_version_id') THEN
          CREATE UNIQUE INDEX IF NOT EXISTS llamada_evaluacion_reunion_rubrica
            ON llamada_evaluacion (reunion_id, (COALESCE(rubrica_version_id, 0))) WHERE reunion_id IS NOT NULL;
        END IF;
      END IF;

      -- objecion_marketing ------------------------------------------------------------------------------
      IF to_regclass('objecion_marketing') IS NOT NULL THEN
        ALTER TABLE objecion_marketing ALTER COLUMN llamada_id DROP NOT NULL;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'objecion_marketing_origen_check' AND conrelid = to_regclass('objecion_marketing')) THEN
          ALTER TABLE objecion_marketing ADD CONSTRAINT objecion_marketing_origen_check CHECK (num_nonnulls(llamada_id, evaluacion_id) >= 1);
        END IF;
      END IF;

      -- rubrica_version (869fpj8dm): admite rúbricas de cierre (closer_f4) ----------------------------------
      IF to_regclass('rubrica_version') IS NOT NULL THEN
        FOR c IN SELECT conname FROM pg_constraint
                 WHERE conrelid = to_regclass('rubrica_version') AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%closer_f3%' AND pg_get_constraintdef(oid) NOT LIKE '%closer_f4%' LOOP
          EXECUTE format('ALTER TABLE rubrica_version DROP CONSTRAINT %I', c.conname);
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('rubrica_version') AND conname = 'rubrica_version_rol_check') THEN
          ALTER TABLE rubrica_version ADD CONSTRAINT rubrica_version_rol_check CHECK (rol IN ('sdr','closer_f2','closer_f3','closer_f4'));
        END IF;
      END IF;

      -- comercial_rol -----------------------------------------------------------------------------------
      IF to_regclass('comercial_rol') IS NOT NULL THEN
        -- Se comprueba antes (y no con ADD COLUMN IF NOT EXISTS) porque un SERIAL omitido puede dejar una secuencia suelta.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                         AND table_name = 'comercial_rol' AND column_name = 'id') THEN
          ALTER TABLE comercial_rol ADD COLUMN id BIGSERIAL;   -- rellena las filas que ya existen
        END IF;
        -- La clave pasa de extension_netelip a id. Ninguna tabla tiene FK hacia comercial_rol.
        FOR c IN SELECT conname FROM pg_constraint
                 WHERE conrelid = to_regclass('comercial_rol') AND contype = 'p'
                   AND pg_get_constraintdef(oid) = 'PRIMARY KEY (extension_netelip)' LOOP
          EXECUTE format('ALTER TABLE comercial_rol DROP CONSTRAINT %I', c.conname);
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comercial_rol') AND contype = 'p') THEN
          ALTER TABLE comercial_rol ADD CONSTRAINT comercial_rol_pkey PRIMARY KEY (id);
        END IF;
        -- La extensión deja de ser obligatoria pero sigue siendo única (varios NULL no chocan).
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comercial_rol') AND contype = 'u'
                         AND pg_get_constraintdef(oid) = 'UNIQUE (extension_netelip)') THEN
          ALTER TABLE comercial_rol ADD CONSTRAINT comercial_rol_extension_netelip_key UNIQUE (extension_netelip);
        END IF;
        ALTER TABLE comercial_rol ALTER COLUMN extension_netelip DROP NOT NULL;
        -- Rol: el CHECK original (sdr, closer_f2, closer_f3) se sustituye por uno con closer_f4.
        FOR c IN SELECT conname FROM pg_constraint
                 WHERE conrelid = to_regclass('comercial_rol') AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%closer_f3%' AND pg_get_constraintdef(oid) NOT LIKE '%closer_f4%' LOOP
          EXECUTE format('ALTER TABLE comercial_rol DROP CONSTRAINT %I', c.conname);
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comercial_rol') AND conname = 'comercial_rol_rol_check') THEN
          ALTER TABLE comercial_rol ADD CONSTRAINT comercial_rol_rol_check CHECK (rol IN ('sdr','closer_f2','closer_f3','closer_f4'));
        END IF;
        -- Una fila por persona. Si ya hubiera duplicados, no se fuerza (rompería el arranque): se avisa en el log.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comercial_rol') AND conname = 'comercial_rol_empleado_id_key') THEN
          IF EXISTS (SELECT empleado_id FROM comercial_rol WHERE empleado_id IS NOT NULL GROUP BY empleado_id HAVING count(*) > 1) THEN
            RAISE WARNING '[reuniones-meet] comercial_rol tiene empleados repetidos: no se aplica UNIQUE (empleado_id) hasta corregirlo';
          ELSE
            ALTER TABLE comercial_rol ADD CONSTRAINT comercial_rol_empleado_id_key UNIQUE (empleado_id);
          END IF;
        END IF;
      END IF;
    END $$;`);
}
