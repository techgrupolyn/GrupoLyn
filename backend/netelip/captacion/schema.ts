// Captación ABCD (épico 869fny187, N-1.1 y N-1.2): tablas aditivas e idempotentes, aplicadas en cada
// arranque después de las del entrenador. No tocan ninguna tabla existente: todo cuelga del id de la
// tarea de ClickUp (`clickup_task_id`). Reversión: backend/netelip/captacion/schema-down.sql.

export const CAPTACION_TABLES = [
  'categoria_config', 'lead_presupuesto_evento', 'lead_calificacion_historial',
  'criterio_config', 'agregacion_config', 'lead_criterio_evaluacion', 'lead_no_apto_evento',
] as const;

/** Acepta el `Pool` de pg o cualquier conexión con `query` (las pruebas usan una conexión con esquema propio). */
export async function ensureCaptacion(pool: { query(sql: string): Promise<unknown> }): Promise<void> {
  await pool.query(`
    -- N-1.1 · Flujo de captación: presupuesto vigente, categoría y ponderado con histórico.
    -- Esquema aditivo e idempotente (CREATE ... IF NOT EXISTS): se puede aplicar al arrancar sin riesgo
    -- y no toca ninguna tabla existente. Reversión: backend/netelip/captacion/schema-down.sql.
    -- Importes en EUR, sin decimales (NUMERIC(14,0)). La fecha del presupuesto vive aquí, no en ClickUp.

    -- Pesos por categoría (RN-3). Versionados: un cambio de pesos es una versión nueva, no un UPDATE.
    CREATE TABLE IF NOT EXISTS categoria_config (
      categoria        TEXT         NOT NULL,
      version          SMALLINT     NOT NULL DEFAULT 1,
      valor_ponderado  NUMERIC(4,2),                      -- NULL = no pondera (sin_calificar)
      orden            SMALLINT     NOT NULL,             -- orden de la vista: A+, A, B, C, D, sin_calificar, no_apto
      vigente_desde    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (categoria, version),
      CONSTRAINT categoria_config_categoria_ck
        CHECK (categoria IN ('A+', 'A', 'B', 'C', 'D', 'sin_calificar', 'no_apto')),
      CONSTRAINT categoria_config_valor_ck
        CHECK (valor_ponderado IS NULL OR valor_ponderado >= 0)
    );

    INSERT INTO categoria_config (categoria, version, valor_ponderado, orden) VALUES
      ('A+',            1, 1.00, 1),
      ('A',             1, 1.00, 2),
      ('B',             1, 0.75, 3),
      ('C',             1, 0.45, 4),
      ('D',             1, 0.15, 5),
      ('sin_calificar', 1, NULL, 6),
      ('no_apto',       1, 0,    7)
    ON CONFLICT (categoria, version) DO NOTHING;

    -- Cada vez que alguien (cliente, IA, comercial) menciona un presupuesto. Nunca se borra ni se edita.
    CREATE TABLE IF NOT EXISTS lead_presupuesto_evento (
      id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      clickup_task_id    TEXT         NOT NULL,
      fuente             TEXT         NOT NULL,
      tipo               TEXT         NOT NULL,
      valor_min          NUMERIC(14,0),
      valor_max          NUMERIC(14,0),
      valor_vigente      NUMERIC(14,0) NOT NULL,           -- exacto: el importe; rango: el valor central
      moneda             CHAR(3)      NOT NULL DEFAULT 'EUR',
      emisor             TEXT         NOT NULL,
      cita_textual       TEXT,
      interaccion_id     TEXT,
      fecha_interaccion  TIMESTAMPTZ  NOT NULL,            -- RN-8: manda esta fecha, no la de proceso
      registrado_por     TEXT         NOT NULL,
      usuario_id         TEXT,
      creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT lead_presupuesto_evento_fuente_ck
        CHECK (fuente IN ('formulario', 'llamada_netelip', 'reunion_meet', 'whatsapp', 'fase2_lyn', 'manual')),
      CONSTRAINT lead_presupuesto_evento_tipo_ck
        CHECK (tipo IN ('exacto', 'rango', 'abierto_superior', 'abierto_inferior')),
      CONSTRAINT lead_presupuesto_evento_emisor_ck
        CHECK (emisor IN ('cliente', 'lyn')),
      CONSTRAINT lead_presupuesto_evento_registrado_por_ck
        CHECK (registrado_por IN ('sistema', 'ia', 'usuario')),
      CONSTRAINT lead_presupuesto_evento_valor_ck
        CHECK (valor_vigente > 0),                          -- un presupuesto 0 es «vacío», no un importe
      CONSTRAINT lead_presupuesto_evento_rango_ck
        CHECK (valor_min IS NULL OR valor_max IS NULL OR valor_min <= valor_max),
      -- Cada tipo trae los importes que le corresponden.
      CONSTRAINT lead_presupuesto_evento_tipo_valores_ck CHECK (
        (tipo = 'exacto' AND valor_min IS NOT NULL AND (valor_max IS NULL OR valor_max = valor_min))
        OR (tipo = 'rango' AND valor_min IS NOT NULL AND valor_max IS NOT NULL)
        OR (tipo = 'abierto_superior' AND valor_min IS NOT NULL)
        OR (tipo = 'abierto_inferior' AND valor_max IS NOT NULL)
      ),
      CONSTRAINT lead_presupuesto_evento_interaccion_uq
        UNIQUE (fuente, interaccion_id)                     -- la misma interacción no se registra dos veces
    );

    CREATE INDEX IF NOT EXISTS lead_presupuesto_evento_lead_idx
      ON lead_presupuesto_evento (clickup_task_id, fecha_interaccion DESC);

    -- Cada vez que cambia la calificación de un lead. Nunca se borra ni se edita.
    CREATE TABLE IF NOT EXISTS lead_calificacion_historial (
      id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Orden estricto de inserción: dos filas del mismo instante (p. ej. «A+ elegida» y su corrección a A)
      -- comparten creado_en, así que el «estado anterior» se lee por seq, no por fecha.
      seq                    BIGINT       GENERATED ALWAYS AS IDENTITY,
      clickup_task_id        TEXT         NOT NULL,
      categoria              TEXT         NOT NULL,
      puntuacion             NUMERIC(3,2),                  -- la rellena N-1.2 (0,00 a 4,00)
      cobertura              NUMERIC(5,2),                  -- la rellena N-1.2 (porcentaje, 0 a 100)
      presupuesto_vigente    NUMERIC(14,0),
      valor_ponderado        NUMERIC(4,2),                  -- el factor de la categoría (1,00 / 0,75 / ...)
      ponderado              NUMERIC(14,0),                 -- presupuesto_vigente x valor_ponderado
      motivo                 TEXT         NOT NULL,
      evento_presupuesto_id  UUID         REFERENCES lead_presupuesto_evento (id) ON DELETE SET NULL,
      version_config         SMALLINT     NOT NULL DEFAULT 1,
      creado_en              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      creado_por             TEXT         NOT NULL DEFAULT 'sistema',
      CONSTRAINT lead_calificacion_historial_categoria_ck
        CHECK (categoria IN ('A+', 'A', 'B', 'C', 'D', 'sin_calificar', 'no_apto')),
      CONSTRAINT lead_calificacion_historial_motivo_ck
        CHECK (motivo IN ('alta', 'cambio_presupuesto', 'cambio_categoria_manual', 'evaluacion_ia', 'recalculo_config')),
      CONSTRAINT lead_calificacion_historial_puntuacion_ck
        CHECK (puntuacion IS NULL OR (puntuacion >= 0 AND puntuacion <= 4)),
      CONSTRAINT lead_calificacion_historial_cobertura_ck
        CHECK (cobertura IS NULL OR (cobertura >= 0 AND cobertura <= 100))
    );

    CREATE INDEX IF NOT EXISTS lead_calificacion_historial_lead_idx
      ON lead_calificacion_historial (clickup_task_id, creado_en DESC);

    -- N-1.2 · Matriz de 7 criterios: configuración, evaluación por criterio y No apto (ticket 869fny1eg).
    -- Se aplica DESPUÉS de las tablas de N-1.1 (más arriba). Aditivo e idempotente (CREATE ... IF NOT EXISTS,
    -- ON CONFLICT DO NOTHING): se puede aplicar al arrancar sin riesgo y no toca ninguna tabla existente.
    -- Reversión: backend/netelip/captacion/schema-down.sql.

    -- Matriz de Alex. Versionada: cambiar un peso o un descriptor es una versión nueva, no un UPDATE.
    -- \`etiqueta\` (Pres, Urg, Dec…) es la abreviatura del campo «Desglose de calificación».
    CREATE TABLE IF NOT EXISTS criterio_config (
      criterio_id    TEXT         NOT NULL,
      version        SMALLINT     NOT NULL DEFAULT 1,
      nombre         TEXT         NOT NULL,
      etiqueta       TEXT         NOT NULL,
      peso           SMALLINT     NOT NULL,                  -- porcentaje entero; los 7 suman 100
      descriptor_a   TEXT         NOT NULL,
      descriptor_b   TEXT         NOT NULL,
      descriptor_c   TEXT         NOT NULL,
      descriptor_d   TEXT         NOT NULL,
      orden          SMALLINT     NOT NULL,
      vigente_desde  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (criterio_id, version),
      CONSTRAINT criterio_config_id_ck
        CHECK (criterio_id IN ('presupuesto', 'urgencia', 'decisor', 'alcance', 'actitud', 'encaje_lyn', 'predisposicion_f2f3')),
      CONSTRAINT criterio_config_peso_ck CHECK (peso BETWEEN 0 AND 100)
    );

    INSERT INTO criterio_config (criterio_id, version, nombre, etiqueta, peso, descriptor_a, descriptor_b, descriptor_c, descriptor_d, orden) VALUES
      ('presupuesto', 1, 'Presupuesto', 'Pres', 25,
        'Encaja cómodo', 'Encaja, pero hay que ajustar', 'Justo', 'Muy justo', 1),
      ('urgencia', 1, 'Urgencia', 'Urg', 25,
        '0–3 meses', '3–6 meses', '6–12 meses', 'Más de 12 meses', 2),
      ('decisor', 1, 'Decisor', 'Dec', 15,
        'Decide él/ella o pareja alineada', 'Falta validar algo menor', 'Pareja o familia influye', 'No decide', 3),
      ('alcance', 1, 'Alcance', 'Alc', 10,
        'Reforma integral clara', 'Integral con algún ajuste', 'Global, pero recortable', 'Parcial encubierta', 4),
      ('actitud', 1, 'Actitud', 'Act', 10,
        'Muy implicado, responde rápido', 'Buena actitud', 'Interés medio', 'Frío o lento', 5),
      ('encaje_lyn', 1, 'Encaje LYN', 'Enc', 10,
        'Valora diseño, método y control', 'Entiende el valor', 'Compara mucho precio', 'Busca barato', 6),
      ('predisposicion_f2f3', 1, 'Predisposición a seguir F2/F3 en oficina', 'F2/F3', 5,
        'Acepta el proceso y concreta la próxima reunión',
        'Acepta venir, pendiente de concretar fecha',
        'Dudas («tengo que comentarlo en casa») o resistencia; no se compromete',
        'Rechaza venir o seguir F2/F3', 7)
    ON CONFLICT (criterio_id, version) DO NOTHING;

    -- Puntos por nivel, cortes de la puntuación, cobertura mínima y umbral de A+ (P-09 del épico, propuesta).
    CREATE TABLE IF NOT EXISTS agregacion_config (
      version           SMALLINT      PRIMARY KEY,
      puntos_a          SMALLINT      NOT NULL,
      puntos_b          SMALLINT      NOT NULL,
      puntos_c          SMALLINT      NOT NULL,
      puntos_d          SMALLINT      NOT NULL,
      corte_a           NUMERIC(3,2)  NOT NULL,
      corte_b           NUMERIC(3,2)  NOT NULL,
      corte_c           NUMERIC(3,2)  NOT NULL,
      cobertura_minima  NUMERIC(3,2)  NOT NULL,
      umbral_a_plus     NUMERIC(14,0) NOT NULL,
      vigente_desde     TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT agregacion_config_cortes_ck CHECK (corte_a > corte_b AND corte_b > corte_c AND corte_c >= 0),
      CONSTRAINT agregacion_config_cobertura_ck CHECK (cobertura_minima >= 0 AND cobertura_minima <= 1)
    );

    INSERT INTO agregacion_config (version, puntos_a, puntos_b, puntos_c, puntos_d, corte_a, corte_b, corte_c, cobertura_minima, umbral_a_plus)
    VALUES (1, 4, 3, 2, 1, 3.50, 2.50, 1.50, 0.50, 100000)
    ON CONFLICT (version) DO NOTHING;

    -- Una fila por criterio y por llamada (también las NE: constan como «sin información»). Nunca se borra ni se edita.
    -- El nivel vigente de un criterio es el de la llamada más reciente por FECHA de la interacción con evidencia
    -- citada; el provisional del formulario (solo Alcance) vale mientras ninguna llamada lo sustituya.
    CREATE TABLE IF NOT EXISTS lead_criterio_evaluacion (
      id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      clickup_task_id    TEXT         NOT NULL,
      criterio_id        TEXT         NOT NULL,
      nivel              TEXT         NOT NULL,
      plazo_meses        NUMERIC(5,1),                       -- solo Urgencia: lo extrae el modelo, el nivel lo asigna el código
      origen             TEXT         NOT NULL,
      cita               TEXT,
      marca_tiempo       TEXT,
      interaccion_id     TEXT,
      fecha_interaccion  TIMESTAMPTZ  NOT NULL,
      creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT lead_criterio_evaluacion_criterio_ck
        CHECK (criterio_id IN ('presupuesto', 'urgencia', 'decisor', 'alcance', 'actitud', 'encaje_lyn', 'predisposicion_f2f3')),
      CONSTRAINT lead_criterio_evaluacion_nivel_ck CHECK (nivel IN ('A', 'B', 'C', 'D', 'NE')),
      CONSTRAINT lead_criterio_evaluacion_origen_ck CHECK (origen IN ('llamada', 'formulario_provisional')),
      -- Un nivel de llamada distinto de NE exige cita; NE no lleva cita.
      CONSTRAINT lead_criterio_evaluacion_cita_ck
        CHECK (origen <> 'llamada' OR nivel = 'NE' OR (cita IS NOT NULL AND btrim(cita) <> '')),
      CONSTRAINT lead_criterio_evaluacion_ne_ck CHECK (nivel <> 'NE' OR cita IS NULL),
      CONSTRAINT lead_criterio_evaluacion_plazo_ck
        CHECK (plazo_meses IS NULL OR (criterio_id = 'urgencia' AND plazo_meses >= 0)),
      CONSTRAINT lead_criterio_evaluacion_llamada_ck CHECK (origen <> 'llamada' OR interaccion_id IS NOT NULL),
      CONSTRAINT lead_criterio_evaluacion_provisional_ck
        CHECK (origen <> 'formulario_provisional' OR (criterio_id = 'alcance' AND nivel <> 'NE')),
      CONSTRAINT lead_criterio_evaluacion_interaccion_uq UNIQUE (interaccion_id, criterio_id)
    );

    -- Un solo nivel provisional por lead y criterio.
    CREATE UNIQUE INDEX IF NOT EXISTS lead_criterio_evaluacion_provisional_uq
      ON lead_criterio_evaluacion (clickup_task_id, criterio_id) WHERE origen = 'formulario_provisional';
    CREATE INDEX IF NOT EXISTS lead_criterio_evaluacion_lead_idx
      ON lead_criterio_evaluacion (clickup_task_id, criterio_id, fecha_interaccion DESC);

    -- «Presupuesto insuficiente y sin solución». La IA lo marca o lo levanta siempre con cita; el comercial, sin ella.
    CREATE TABLE IF NOT EXISTS lead_no_apto_evento (
      id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      clickup_task_id    TEXT         NOT NULL,
      valor              BOOLEAN      NOT NULL,
      cita               TEXT,
      interaccion_id     TEXT,
      fecha_interaccion  TIMESTAMPTZ  NOT NULL,
      registrado_por     TEXT         NOT NULL,
      usuario_id         TEXT,
      creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT lead_no_apto_evento_registrado_por_ck CHECK (registrado_por IN ('ia', 'usuario')),
      CONSTRAINT lead_no_apto_evento_cita_ck
        CHECK (registrado_por <> 'ia' OR (cita IS NOT NULL AND btrim(cita) <> '')),
      CONSTRAINT lead_no_apto_evento_interaccion_uq UNIQUE (interaccion_id)
    );

    CREATE INDEX IF NOT EXISTS lead_no_apto_evento_lead_idx
      ON lead_no_apto_evento (clickup_task_id, fecha_interaccion DESC);
  `);
}
