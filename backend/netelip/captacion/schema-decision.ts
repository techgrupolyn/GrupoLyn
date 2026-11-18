// N-1.4 · Decisión de pase del SDR (ticket 869fpj8e0): tablas aditivas e idempotentes. Se aplican DESPUÉS de las de N-1.1 a N-1.3
// (desde `ensureCaptacion`) y no tocan ninguna tabla existente. Reversión: backend/netelip/captacion/schema-down.sql.

import type { Decision } from './decision.ts';

export const DECISION_TABLES = ['decision_motivo_config', 'decision_contexto_config', 'decision_lead', 'validacion_decision'] as const;

/**
 * Lista de motivos de la versión 1. PROVISIONAL: no tengo el borrador del documento de dudas de Alex (P-04). Es la semilla de la base
 * y también lo que usa el prompt cuando se arma sin base (pruebas); la lista real se publica en decision_motivo_config con una versión
 * nueva, sin desplegar.
 */
export const MOTIVOS_V1: ReadonlyArray<readonly [Decision, string, string]> = [
  ['pasar_a_reunion', 'cumple_criterios', 'Cumple los criterios de la sesión de conceptos'],
  ['pasar_a_reunion', 'cita_agendada', 'Cita agendada en la llamada'],
  ['derivar_partners', 'presupuesto_partners', 'Presupuesto dentro del rango de Partners'],
  ['derivar_partners', 'alcance_partners', 'Alcance parcial que encaja en Partners'],
  ['seguimiento', 'falta_plano', 'Falta el plano'],
  ['seguimiento', 'falta_decisor', 'Falta que decida otra persona'],
  ['seguimiento', 'pide_tiempo', 'Pide tiempo para decidir'],
  ['seguimiento', 'compra_pendiente', 'Compra de la vivienda pendiente'],
  ['seguimiento', 'sin_respuesta', 'No contesta'],
  ['descartar', 'presupuesto_insuficiente', 'Presupuesto insuficiente sin solución'],
  ['descartar', 'fuera_de_zona', 'Fuera de la zona de trabajo'],
  ['descartar', 'no_interesado', 'El cliente decide no seguir'],
  ['descartar', 'no_es_reforma', 'No es una reforma de vivienda'],
];

/** Las filas de la versión 1 como el VALUES del INSERT (el orden dentro de cada decisión es el de la lista). */
const filasMotivosV1 = (): string => {
  const contador: Record<string, number> = {};
  return MOTIVOS_V1.map(([decision, codigo, etiqueta]) => {
    contador[decision] = (contador[decision] ?? 0) + 1;
    return `      (1, '${decision}', '${codigo}', '${etiqueta.replaceAll("'", "''")}', ${contador[decision]})`;
  }).join(',\n');
};

/**
 * Texto de la versión 1 del manual de reglas. PROVISIONAL: lo armé con las reglas explícitas del ticket (escalado, descartes,
 * próximos pasos) porque no tengo el documento «Reglas de escalado» de Alex. Se sustituye publicando una versión nueva en
 * `decision_contexto_config` (una fila con versión mayor), sin desplegar.
 */
export const MANUAL_V1_PROVISIONAL = `MANUAL DE REGLAS v1 (provisional)
Alcance: solo la decisión de PASE del SDR (si el lead pasa o no a la sesión de conceptos, F2). No decides por los closers.
Decisiones posibles: pasar_a_reunion (sesión de conceptos, F2), derivar_partners (LYN Partners), seguimiento, descartar.
Seguimiento: si solo falta un dato que puede aportar el cliente (plano, fecha de compra, disponibilidad de la pareja), la decisión es seguimiento y NO se escala por ese motivo.
Descartar: revisa el caso y valida únicamente un descarte cuando esté claro por qué el proyecto queda fuera de Grupo LYN y de LYN Partners. Ante la mínima duda que pueda cambiar esa conclusión, marca «Pendiente de Ernesto» (pendiente_ernesto) e indica qué debe decidir. Si el cliente decide no seguir, el motivo es del cliente.
Excepciones, que obligan a que decida Ernesto aunque la decisión sea clara (devuélvelas en excepciones): descuento, condiciones_pago, topografo (alguien tiene que ir a medir), fuera_de_zona, videollamada (sesión por videollamada) y sin_decisor (sesión sin uno de los decisores). Un próximo paso que dependa de una excepción lleva requiere_ernesto true y no se presenta como compromiso.
Dudas que cambian la decisión (devuélvelas en dudas): presupuesto_limite (presupuesto al límite), encaje_incierto (encaje incierto entre LYN y Partners) y viabilidad_tecnica (viabilidad técnica pendiente).
Próximos pasos (de 1 a 3, solo lo que el guion permite): seguimiento = cuándo volver a llamar y con qué gancho; pasar_a_reunion = qué falta para la sesión (decisores, plano, fotos, vídeo); derivar_partners = qué contar al cliente y qué pasar a Partners; descartar = una vía de recuperación (Partners, otro alcance) o ningún paso. Pon una fecha solo si el cliente la dio; si no, el plazo relativo que marque el guion.
Es una recomendación: no crea avisos, tareas ni mensajes, y no mueve la tarjeta de fase.`;

/** Marca de la versión 1 del guion hasta que se cargue el texto real del «Guion completo SDR Grupo LYN». */
export const GUION_V1_PENDIENTE = 'GUION v1: pendiente de cargar el texto del «Guion completo SDR Grupo LYN». Mientras tanto decide con el manual de reglas y con lo que se dice en la llamada.';

/** Acepta el `Pool` de pg o cualquier conexión con `query` (las pruebas usan una conexión con esquema propio). */
export async function ensureDecision(pool: { query(sql: string): Promise<unknown> }): Promise<void> {
  await pool.query(`
    -- Lista cerrada de motivos de cada decisión, configurable (P-04). Versionada: cambiar la lista es publicar una versión nueva
    -- (el código lee la de mayor versión), sin desplegar. «otro» existe siempre y no se configura. Versión 1 PROVISIONAL.
    CREATE TABLE IF NOT EXISTS decision_motivo_config (
      version        SMALLINT     NOT NULL,
      decision       TEXT         NOT NULL,
      codigo         TEXT         NOT NULL,
      etiqueta       TEXT         NOT NULL,
      orden          SMALLINT     NOT NULL,
      vigente_desde  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (version, decision, codigo),
      CONSTRAINT decision_motivo_config_decision_ck
        CHECK (decision IN ('pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar')),
      CONSTRAINT decision_motivo_config_codigo_ck CHECK (codigo ~ '^[a-z0-9_]+$' AND codigo <> 'otro'),
      CONSTRAINT decision_motivo_config_etiqueta_ck CHECK (btrim(etiqueta) <> '')
    );

    INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES
${filasMotivosV1()}
    ON CONFLICT (version, decision, codigo) DO NOTHING;

    -- Guion del SDR y manual de reglas que recibe la IA. Versionados por tipo: un guion nuevo es una fila nueva, sin desplegar.
    -- Cada decisión guarda las versiones con que se tomó. Versión 1 PROVISIONAL (ver decision-contexto en schema-decision.ts).
    CREATE TABLE IF NOT EXISTS decision_contexto_config (
      tipo           TEXT         NOT NULL,
      version        SMALLINT     NOT NULL,
      texto          TEXT         NOT NULL,
      vigente_desde  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (tipo, version),
      CONSTRAINT decision_contexto_config_tipo_ck CHECK (tipo IN ('guion', 'manual')),
      CONSTRAINT decision_contexto_config_texto_ck CHECK (btrim(texto) <> '')
    );

    INSERT INTO decision_contexto_config (tipo, version, texto) VALUES
      ('manual', 1, $manual$${MANUAL_V1_PROVISIONAL}$manual$),
      ('guion', 1, $guion$${GUION_V1_PENDIENTE}$guion$)
    ON CONFLICT (tipo, version) DO NOTHING;

    -- Una fila por actor y llamada: lo que propuso el SDR, lo que decidió la IA y lo que quedó tras Ernesto. Se guardan por
    -- separado para medir cuándo acierta cada uno. Nunca se edita (Ernesto añade su fila; no pisa la de los otros).
    -- lead_id es el id de la tarea de ClickUp; llamada_id es la interacción (netelip:<id>).
    CREATE TABLE IF NOT EXISTS decision_lead (
      id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      seq                BIGINT       GENERATED ALWAYS AS IDENTITY,
      lead_id            TEXT         NOT NULL,
      llamada_id         TEXT         NOT NULL,
      actor              TEXT         NOT NULL,
      decision           TEXT         NOT NULL,
      motivo_codigo      TEXT,
      motivo_texto       TEXT,
      dato_cita          TEXT,
      motivos            JSONB        NOT NULL DEFAULT '[]'::jsonb,      -- IA: todos los motivos con su cita
      excepciones        JSONB        NOT NULL DEFAULT '[]'::jsonb,
      dudas              JSONB        NOT NULL DEFAULT '[]'::jsonb,
      pendiente_ernesto  JSONB,                                          -- IA: {queDebeDecidir}
      proximos_pasos     JSONB        NOT NULL DEFAULT '[]'::jsonb,      -- los genera la IA; Ernesto puede editarlos al corregir
      tipo_caso          TEXT,                                           -- vacío hasta N-1.5
      version_guion      SMALLINT,
      version_manual     SMALLINT,
      version_prompt     TEXT,
      origen             TEXT         NOT NULL DEFAULT 'nuevo',
      a_favor            TEXT,                                           -- Ernesto: con quién estaba de acuerdo al confirmar
      usuario_id         TEXT,
      usuario_nombre     TEXT,
      creado_en          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT decision_lead_actor_ck CHECK (actor IN ('sdr', 'ia', 'ernesto')),
      CONSTRAINT decision_lead_decision_ck CHECK (decision IN ('pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar')),
      CONSTRAINT decision_lead_origen_ck CHECK (origen IN ('nuevo', 'historico')),
      CONSTRAINT decision_lead_a_favor_ck CHECK (a_favor IS NULL OR (actor = 'ernesto' AND a_favor IN ('sdr', 'ia'))),
      -- Una propuesta de persona (SDR o Ernesto) siempre lleva su dato; la del SDR, además, su motivo.
      CONSTRAINT decision_lead_persona_ck CHECK (actor = 'ia' OR (dato_cita IS NOT NULL AND btrim(dato_cita) <> '')),
      CONSTRAINT decision_lead_sdr_motivo_ck CHECK (actor <> 'sdr' OR (motivo_codigo IS NOT NULL AND btrim(motivo_codigo) <> '')),
      -- La IA guarda con qué versión del guion y del manual decidió.
      CONSTRAINT decision_lead_ia_versiones_ck CHECK (actor <> 'ia' OR (version_guion IS NOT NULL AND version_manual IS NOT NULL)),
      -- Solo la IA puede ser histórica (la calibración); las personas siempre son del piloto.
      CONSTRAINT decision_lead_historico_ck CHECK (origen = 'nuevo' OR actor = 'ia'),
      CONSTRAINT decision_lead_llamada_actor_uq UNIQUE (llamada_id, actor)
    );

    CREATE INDEX IF NOT EXISTS decision_lead_lead_idx ON decision_lead (lead_id, creado_en DESC);

    -- El caso en la bandeja de Ernesto: se crea cuando existen la propuesta del SDR y la decisión de la IA (piloto: Ernesto valida
    -- el 100 %, también los casos en que coinciden). Los históricos de la calibración no tienen validación.
    CREATE TABLE IF NOT EXISTS validacion_decision (
      llamada_id           TEXT         PRIMARY KEY,
      lead_id              TEXT         NOT NULL,
      coincidencia_sdr_ia  BOOLEAN      NOT NULL,
      motivo_escalado      TEXT         NOT NULL,
      estado               TEXT         NOT NULL DEFAULT 'pendiente_ernesto',
      revisado_por         TEXT,
      revisado_en          TIMESTAMPTZ,
      creado_en            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT validacion_decision_motivo_ck CHECK (motivo_escalado IN ('discrepancia', 'excepcion', 'duda', 'piloto')),
      CONSTRAINT validacion_decision_estado_ck CHECK (estado IN ('pendiente_ernesto', 'validada', 'corregida')),
      CONSTRAINT validacion_decision_revision_ck
        CHECK (estado = 'pendiente_ernesto' OR (revisado_por IS NOT NULL AND revisado_en IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS validacion_decision_estado_idx ON validacion_decision (estado, creado_en);
  `);
}
