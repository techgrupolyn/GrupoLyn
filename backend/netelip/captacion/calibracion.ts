import type { Pool } from 'pg';
import type { Decision } from './decision.ts';
import { ejecutarLote, numeroDeEtapa, type OpcionesLote } from './lote.ts';
import { interaccionDe } from './proceso.ts';

// N-1.4 · Calibración con el histórico (P-07, resuelta por Jean el 18/11): la IA decide sobre TODAS las llamadas ya transcritas que
// tengan su lead identificado y se compara con lo que pasó con el lead en «Contacto de Reforma» (fase alcanzada o «No continuidad»),
// leído sin escribir en el tablero. Las decisiones quedan como `historico`: no entran en la bandeja ni en el acierto del piloto.
// Las llamadas sin lead identificado no se analizan y quedan fuera del informe (solo se cuentan).

export type Desenlace = 'avanzo' | 'perdido' | 'antes_de_f2' | 'sin_etapa';
export type Contraste = 'coincide' | 'difiere' | 'sin_referencia';

/**
 * Qué pasó con el lead según su fase actual: de F2 (e4) en adelante, o GANADO (e14) o PASE (e18) = avanzó; PERDIDO (e15) o RECHAZADO
 * (e16) = perdido; antes de F2 (e1 a e3) = aún no pasó; cualquier otra cosa o sin fase = sin referencia.
 */
export function desenlaceDeLead(etapa: string | null): Desenlace {
  const n = numeroDeEtapa(etapa);
  if (n === null) return 'sin_etapa';
  if (n === 15 || n === 16) return 'perdido';
  if ((n >= 4 && n <= 14) || n === 18) return 'avanzo';
  if (n >= 1 && n < 4) return 'antes_de_f2';
  return 'sin_etapa';
}

/**
 * Compara la decisión de la IA con el desenlace del lead. Es una referencia orientativa, no una verdad: un lead puede avanzar o perderse
 * por motivos que la llamada no decía.
 * - pasar_a_reunion coincide si el lead avanzó; descartar, si se perdió; seguimiento, si sigue antes de F2.
 * - derivar_partners no tiene desenlace en este tablero: sin referencia. Un seguimiento que acabó en avance o pérdida tampoco la tiene.
 */
export function contrastar(decision: Decision, desenlace: Desenlace): Contraste {
  if (desenlace === 'sin_etapa' || decision === 'derivar_partners') return 'sin_referencia';
  if (decision === 'pasar_a_reunion') return desenlace === 'avanzo' ? 'coincide' : 'difiere';
  if (decision === 'descartar') return desenlace === 'perdido' ? 'coincide' : 'difiere';
  return desenlace === 'antes_de_f2' ? 'coincide' : 'sin_referencia';
}

export interface FilaCalibracion {
  fecha: string;
  llamadaId: string;
  lead: string;
  leadId: string;
  etapa: string | null;
  categoria: string | null;
  decisionIA: Decision | null;
  motivo: string | null;
  excepciones: string[];
  dudas: string[];
  pendienteErnesto: boolean;
  desenlace: Desenlace;
  noContinuidad: string | null;
  contraste: Contraste | null;
}

export interface InformeCalibracion {
  filas: FilaCalibracion[];
  resumen: {
    /** Llamadas con transcripción en la ventana. */
    llamadas: number;
    /** Con lead identificado y procesadas: las que entran en el informe. */
    analizadas: number;
    /** Sin lead identificado (o sin conversación): quedan fuera del informe. */
    sinLead: number;
    /** Fallos del modelo o de la salida: ni se analizaron ni están en el informe. */
    errores: number;
    conDecision: number;
    sinDecision: number;
    porDecision: Record<string, number>;
    porContraste: Record<string, number>;
    /** Coincidencias entre las que tienen referencia, en porcentaje entero; null si ninguna la tiene. */
    coincidenciaPorcentaje: number | null;
  };
}

export interface DecisionHistorica {
  llamadaId: string;
  decision: Decision;
  motivo: string | null;
  excepciones: string[];
  dudas: string[];
  pendienteErnesto: boolean;
}

const contar = <T>(xs: readonly T[], clave: (x: T) => string | null): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const x of xs) {
    const k = clave(x);
    if (k) m[k] = (m[k] ?? 0) + 1;
  }
  return m;
};

/** Arma el informe con lo que analizó el lote y las decisiones históricas guardadas. Pura. */
export function armarInforme(
  filasLote: ReadonlyArray<{ llamadaId: string; ocurridaEn: string; estado: string; categoria: string | null; lead: { id: string; nombre: string; etapa: string | null; noContinuidad?: string | null } | null }>,
  decisiones: ReadonlyArray<DecisionHistorica>,
): InformeCalibracion {
  const porLlamada = new Map(decisiones.map((d) => [d.llamadaId, d]));
  const analizadas = filasLote.filter((f) => f.estado === 'procesada' && f.lead !== null);
  const filas: FilaCalibracion[] = analizadas.map((f) => {
    const d = porLlamada.get(interaccionDe(f.llamadaId)) ?? null;
    const desenlace = desenlaceDeLead(f.lead!.etapa);
    return {
      fecha: f.ocurridaEn, llamadaId: f.llamadaId, lead: f.lead!.nombre, leadId: f.lead!.id, etapa: f.lead!.etapa, categoria: f.categoria,
      decisionIA: d?.decision ?? null, motivo: d?.motivo ?? null, excepciones: d?.excepciones ?? [], dudas: d?.dudas ?? [], pendienteErnesto: d?.pendienteErnesto ?? false,
      desenlace, noContinuidad: f.lead!.noContinuidad ?? null, contraste: d ? contrastar(d.decision, desenlace) : null,
    };
  });
  const conReferencia = filas.filter((f) => f.contraste === 'coincide' || f.contraste === 'difiere');
  const coinciden = conReferencia.filter((f) => f.contraste === 'coincide').length;
  return {
    filas,
    resumen: {
      llamadas: filasLote.length,
      analizadas: filas.length,
      sinLead: filasLote.filter((f) => f.estado === 'sin_lead' || f.estado === 'sin_conversacion').length,
      errores: filasLote.filter((f) => f.estado === 'error' || f.estado === 'modelo_fallo' || f.estado === 'salida_invalida').length,
      conDecision: filas.filter((f) => f.decisionIA !== null).length,
      sinDecision: filas.filter((f) => f.decisionIA === null).length,
      porDecision: contar(filas, (f) => f.decisionIA),
      porContraste: contar(filas, (f) => f.contraste),
      coincidenciaPorcentaje: conReferencia.length === 0 ? null : Math.round((coinciden / conReferencia.length) * 100),
    },
  };
}

export interface OpcionesCalibracion extends Omit<OpcionesLote, 'candidatos' | 'escribirMaximo' | 'origenDecision'> {
  pool: Pool;
}

/**
 * Ejecuta la calibración: el lote sobre toda la ventana, con todos los leads de la lista como candidatos (también los ya cerrados, que
 * son los que tienen desenlace), sin escribir nada en ClickUp y guardando las decisiones como históricas.
 */
export async function ejecutarCalibracion(o: OpcionesCalibracion): Promise<InformeCalibracion> {
  const lote = await ejecutarLote({ ...o, candidatos: 'todos', escribirMaximo: 0, origenDecision: 'historico' });
  const ids = lote.filas.filter((f) => f.estado === 'procesada').map((f) => interaccionDe(f.llamadaId));
  const { rows } = await o.pool.query<{ llamada_id: string; decision: Decision; motivo_codigo: string | null; excepciones: string[]; dudas: string[]; pendiente_ernesto: unknown }>(
    `SELECT llamada_id, decision, motivo_codigo, excepciones, dudas, pendiente_ernesto FROM decision_lead
     WHERE actor = 'ia' AND origen = 'historico' AND llamada_id = ANY($1::text[])`,
    [ids],
  );
  return armarInforme(
    lote.filas,
    rows.map((r) => ({ llamadaId: r.llamada_id, decision: r.decision, motivo: r.motivo_codigo, excepciones: r.excepciones ?? [], dudas: r.dudas ?? [], pendienteErnesto: r.pendiente_ernesto !== null })),
  );
}
