import { citaVerificable } from './salida-modelo.ts';

// N-1.4 · Decisión de pase del SDR validada por la IA y por Ernesto (ticket 869fpj8e0). Lógica pura: contrato de lo que propone el
// modelo (`decision_ia`), verificación de sus citas, comparación SDR frente a IA, motivo de escalado y medición del acierto.
// Nada de aquí escribe en ClickUp ni mueve fases: la decisión es una recomendación que ejecutan el SDR o Ernesto.

export const DECISIONES = ['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar'] as const;
export type Decision = (typeof DECISIONES)[number];

export const ETIQUETA_DECISION: Record<Decision, string> = {
  pasar_a_reunion: 'Pasar a reunión',
  derivar_partners: 'Derivar a LYN Partners',
  seguimiento: 'Seguimiento',
  descartar: 'Descartar',
};

export const ACTORES = ['sdr', 'ia', 'ernesto'] as const;
export type Actor = (typeof ACTORES)[number];

export const MOTIVOS_ESCALADO = ['discrepancia', 'excepcion', 'duda', 'piloto'] as const;
export type MotivoEscalado = (typeof MOTIVOS_ESCALADO)[number];

export const ESTADOS_VALIDACION = ['pendiente_ernesto', 'validada', 'corregida'] as const;
export type EstadoValidacion = (typeof ESTADOS_VALIDACION)[number];

export type Origen = 'nuevo' | 'historico';

/** Excepciones que obligan a que Ernesto decida antes de actuar (aunque SDR e IA coincidan). */
export const EXCEPCIONES = ['descuento', 'condiciones_pago', 'topografo', 'fuera_de_zona', 'videollamada', 'sin_decisor'] as const;
export type Excepcion = (typeof EXCEPCIONES)[number];

/** Dudas que cambian la decisión (presupuesto al límite, encaje incierto, viabilidad técnica pendiente). */
export const DUDAS = ['presupuesto_limite', 'encaje_incierto', 'viabilidad_tecnica'] as const;
export type Duda = (typeof DUDAS)[number];

export const CANALES = ['llamada', 'whatsapp', 'email'] as const;
export type Canal = (typeof CANALES)[number];
export const TIPOS_CUANDO = ['fecha_cliente', 'plazo_guion'] as const;
export type TipoCuando = (typeof TIPOS_CUANDO)[number];

export const MOTIVO_OTRO = 'otro';
export const MAX_PASOS = 3;
export const MAX_MOTIVOS = 3;
/** La cita de un próximo paso puede ser más corta que la de un criterio («vuelvo el 20»): 3 palabras como mínimo. */
export const MIN_PALABRAS_CITA_PASO = 3;
/** F2 = e4 VISITA. Un lead que ya está en F2 o más allá queda fuera: esta fase es solo de la decisión de pase del SDR. */
export const ETAPA_F2 = 4;

/** La entrada de una persona (SDR o Ernesto) no cumple las reglas: se devuelve tal cual como 400. */
export class EntradaInvalida extends Error {}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const textoONull = (v: unknown): string | null => texto(v) || null;
const enLista = <T extends string>(lista: readonly T[], v: unknown): v is T => typeof v === 'string' && (lista as readonly string[]).includes(v);

// ---------------------------------------------------------------------------------------------
// Lista de motivos (configurable: viene de la base, no del código)
// ---------------------------------------------------------------------------------------------

export interface MotivoConfig {
  codigo: string;
  etiqueta: string;
}
export type MotivosPorDecision = Record<Decision, readonly MotivoConfig[]>;

/** El código es válido para la decisión (de su lista) o es «otro», que siempre existe. */
export const motivoValido = (motivos: MotivosPorDecision, decision: Decision, codigo: string): boolean =>
  codigo === MOTIVO_OTRO || motivos[decision].some((m) => m.codigo === codigo);

// ---------------------------------------------------------------------------------------------
// Próximos pasos
// ---------------------------------------------------------------------------------------------

export interface ProximoPaso {
  orden: number;
  accion: string;
  cuando: { tipo: TipoCuando; valor: string };
  canal: Canal;
  /** Qué pedir o qué llevar. */
  quePedir: string | null;
  /** Necesita una excepción (topógrafo, descuento, fuera de zona, videollamada, sesión sin un decisor): no se presenta como compromiso. */
  requiereErnesto: boolean;
  cita: string | null;
}

export interface MotivoIA {
  codigo: string;
  /** Texto libre, solo con el código «otro». */
  texto: string | null;
  cita: string;
}

export interface DecisionIA {
  decision: Decision;
  motivos: MotivoIA[];
  excepciones: Excepcion[];
  dudas: Duda[];
  /** «Pendiente de Ernesto»: qué debe decidir. Ante la mínima duda que pueda cambiar la conclusión. */
  pendienteErnesto: { queDebeDecidir: string } | null;
  proximosPasos: ProximoPaso[];
}

/** Lo que el modelo devolvió, sin verificar (campos opcionales y de cualquier tipo). */
export interface DecisionIABruta {
  decision: unknown;
  motivos: unknown;
  excepciones: unknown;
  dudas: unknown;
  pendienteErnesto: unknown;
  proximosPasos: unknown;
}

/** Lee el objeto `decision_ia` del JSON del modelo. Sin objeto (o `null`) no hay decisión: la llamada se califica igual. */
export function leerDecisionIA(bruto: unknown): DecisionIABruta | null {
  if (!esObjeto(bruto)) return null;
  return {
    decision: bruto.decision,
    motivos: bruto.motivos,
    excepciones: bruto.excepciones,
    dudas: bruto.dudas,
    pendienteErnesto: bruto.pendiente_ernesto,
    proximosPasos: bruto.proximos_pasos,
  };
}

export interface DescarteDecision {
  campo: string;
  motivo: string;
}

export type ResultadoDecisionIA =
  | { ok: true; decision: DecisionIA; descartes: DescarteDecision[] }
  | { ok: false; detalle: string };

const PENDIENTE_SIN_CITAS = 'La IA no pudo citar la llamada para justificar su decisión.';

/**
 * El código decide qué vale de lo que propuso el modelo:
 * - la decisión debe ser una de las cuatro; si no, no hay decisión de la IA;
 * - cada motivo lleva una cita literal de la transcripción (si no, se descarta) y su código es de la lista de esa decisión
 *   (si no, pasa a «otro»); sin ningún motivo citable la decisión queda «Pendiente de Ernesto»;
 * - cada próximo paso lleva su cita verificable (si no, se descarta), canal y plazo válidos, y hay como mucho 3, numerados desde 1; una
 *   decisión que no es «descartar» y se queda sin pasos verificables se guarda igual, con una nota en los descartes;
 * - una excepción o una duda desconocidas se ignoran.
 */
export function verificarDecisionIA(b: DecisionIABruta, transcripcion: string, motivos: MotivosPorDecision): ResultadoDecisionIA {
  if (!enLista(DECISIONES, b.decision)) return { ok: false, detalle: 'la decisión de la IA no es una de las cuatro posibles' };
  const decision = b.decision;
  const descartes: DescarteDecision[] = [];

  const motivosIA: MotivoIA[] = [];
  for (const m of Array.isArray(b.motivos) ? b.motivos : []) {
    if (!esObjeto(m)) continue;
    const cita = textoONull(m.cita);
    const codigoBruto = texto(m.codigo);
    if (!codigoBruto) continue;
    if (!citaVerificable(cita, transcripcion)) {
      descartes.push({ campo: `decision_ia.motivos.${codigoBruto}`, motivo: 'cita no encontrada en la transcripción' });
      continue;
    }
    const conocido = motivoValido(motivos, decision, codigoBruto);
    const codigo = conocido ? codigoBruto : MOTIVO_OTRO;
    if (motivosIA.some((x) => x.codigo === codigo && codigo !== MOTIVO_OTRO)) continue;
    motivosIA.push({ codigo, texto: codigo === MOTIVO_OTRO ? (textoONull(m.texto) ?? codigoBruto) : null, cita: cita as string });
    if (motivosIA.length === MAX_MOTIVOS) break;
  }

  const pasos: ProximoPaso[] = [];
  for (const p of Array.isArray(b.proximosPasos) ? b.proximosPasos : []) {
    if (!esObjeto(p)) continue;
    const accion = texto(p.accion);
    const cuando = esObjeto(p.cuando) ? p.cuando : {};
    const cita = textoONull(p.cita);
    if (!accion || !enLista(TIPOS_CUANDO, cuando.tipo) || !texto(cuando.valor) || !enLista(CANALES, p.canal)) {
      descartes.push({ campo: 'decision_ia.proximos_pasos', motivo: 'paso incompleto o con un canal o plazo no válido' });
      continue;
    }
    if (!citaVerificable(cita, transcripcion, MIN_PALABRAS_CITA_PASO)) {
      descartes.push({ campo: 'decision_ia.proximos_pasos', motivo: 'cita no encontrada en la transcripción' });
      continue;
    }
    pasos.push({
      orden: 0,
      accion,
      cuando: { tipo: cuando.tipo, valor: texto(cuando.valor) },
      canal: p.canal,
      quePedir: textoONull(p.que_pedir),
      requiereErnesto: p.requiere_ernesto === true,
      cita,
    });
  }
  if (pasos.length > MAX_PASOS) descartes.push({ campo: 'decision_ia.proximos_pasos', motivo: `más de ${MAX_PASOS} pasos: se conservan los primeros` });
  const proximosPasos = pasos.slice(0, MAX_PASOS).map((p, i) => ({ ...p, orden: i + 1 }));
  // La IA recomienda de 1 a 3 pasos con su cita; solo «descartar» puede quedarse sin ninguno (sin vía de recuperación). Sin pasos verificables
  // la decisión se guarda igual, pero consta para que Ernesto sepa que no trae recomendación.
  if (decision !== 'descartar' && proximosPasos.length === 0) {
    descartes.push({ campo: 'decision_ia.proximos_pasos', motivo: 'la decisión no trae ningún próximo paso verificable' });
  }

  const listaSegura = <T extends string>(lista: readonly T[], v: unknown): T[] =>
    [...new Set((Array.isArray(v) ? v : []).filter((x): x is T => enLista(lista, x)))];
  const pendiente = esObjeto(b.pendienteErnesto) ? textoONull(b.pendienteErnesto.que_debe_decidir) : null;

  return {
    ok: true,
    descartes,
    decision: {
      decision,
      motivos: motivosIA,
      excepciones: listaSegura(EXCEPCIONES, b.excepciones),
      dudas: listaSegura(DUDAS, b.dudas),
      pendienteErnesto: pendiente !== null ? { queDebeDecidir: pendiente } : motivosIA.length === 0 ? { queDebeDecidir: PENDIENTE_SIN_CITAS } : null,
      proximosPasos,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Comparación y escalado
// ---------------------------------------------------------------------------------------------

export interface PropuestaResumida {
  decision: Decision;
  motivoCodigo: string | null;
}

export interface Comparacion {
  /** SDR e IA coinciden en la decisión Y en el motivo. Si no, hay discrepancia (también con la misma decisión y otro motivo). */
  coincide: boolean;
  /** Solo la decisión (por si hace falta distinguir «otra decisión» de «misma decisión, otro motivo»). */
  mismaDecision: boolean;
}

export function compararDecisiones(sdr: PropuestaResumida, ia: PropuestaResumida): Comparacion {
  const mismaDecision = sdr.decision === ia.decision;
  return { coincide: mismaDecision && sdr.motivoCodigo === ia.motivoCodigo, mismaDecision };
}

/** Qué hace falta para que una persona confirme: si SDR e IA no coinciden, debe decir con quién está de acuerdo. */
export const requiereAFavor = (c: Comparacion): boolean => !c.coincide;

/**
 * Por qué el caso espera a Ernesto, por orden de prioridad: discrepancia, excepción (también un paso que «requiere Ernesto»), duda
 * o «Pendiente de Ernesto», y el piloto: en el piloto Ernesto valida el 100 %, también los casos en que SDR e IA coinciden.
 */
export function motivoDeEscalado(coincide: boolean, ia: Pick<DecisionIA, 'excepciones' | 'dudas' | 'pendienteErnesto' | 'proximosPasos'>): MotivoEscalado {
  if (!coincide) return 'discrepancia';
  if (ia.excepciones.length > 0 || ia.proximosPasos.some((p) => p.requiereErnesto)) return 'excepcion';
  if (ia.dudas.length > 0 || ia.pendienteErnesto !== null) return 'duda';
  return 'piloto';
}

/** Una llamada a un lead en F2 (e4) o más allá no genera decisión de pase. Sin etapa conocida sí se genera. */
export const generaDecision = (etapa: number | null): boolean => etapa === null || etapa < ETAPA_F2;

// ---------------------------------------------------------------------------------------------
// Entradas de personas
// ---------------------------------------------------------------------------------------------

export interface EntradaDecision {
  decision: Decision;
  motivoCodigo: string;
  motivoTexto: string | null;
  /** El dato de la llamada (o la cita) que justifica la decisión. */
  datoCita: string;
}

const MAX_TEXTO = 1000;

/** Valida lo que una persona propone o corrige: decisión, motivo de la lista (o «otro» con texto) y el dato que lo justifica. */
export function validarEntradaDecision(entrada: unknown, motivos: MotivosPorDecision): EntradaDecision {
  const e = esObjeto(entrada) ? entrada : {};
  if (!enLista(DECISIONES, e.decision)) throw new EntradaInvalida('La decisión debe ser: pasar a reunión, derivar a Partners, seguimiento o descartar.');
  const decision = e.decision;
  const motivoCodigo = texto(e.motivo_codigo);
  if (!motivoCodigo || !motivoValido(motivos, decision, motivoCodigo)) throw new EntradaInvalida('El motivo debe ser uno de la lista de esa decisión, o «otro».');
  const motivoTexto = textoONull(e.motivo_texto);
  if (motivoCodigo === MOTIVO_OTRO && motivoTexto === null) throw new EntradaInvalida('Con el motivo «otro» hay que escribir cuál.');
  const datoCita = texto(e.dato_cita);
  if (!datoCita) throw new EntradaInvalida('Falta el dato de la llamada que justifica la decisión.');
  if (datoCita.length > MAX_TEXTO || (motivoTexto?.length ?? 0) > MAX_TEXTO) throw new EntradaInvalida(`Los textos no pueden pasar de ${MAX_TEXTO} caracteres.`);
  return { decision, motivoCodigo, motivoTexto: motivoCodigo === MOTIVO_OTRO ? motivoTexto : null, datoCita };
}

/** Pasos que edita Ernesto al corregir: sin la cita obligatoria (la hace una persona), pero con el mismo formato. */
export function validarPasosEditados(entrada: unknown): ProximoPaso[] {
  if (entrada === undefined || entrada === null) return [];
  if (!Array.isArray(entrada) || entrada.length > MAX_PASOS) throw new EntradaInvalida(`Los próximos pasos son una lista de hasta ${MAX_PASOS}.`);
  return entrada.map((p, i) => {
    const o = esObjeto(p) ? p : {};
    const cuando = esObjeto(o.cuando) ? o.cuando : {};
    const accion = texto(o.accion);
    if (!accion || !enLista(TIPOS_CUANDO, cuando.tipo) || !texto(cuando.valor) || !enLista(CANALES, o.canal)) {
      throw new EntradaInvalida(`El próximo paso ${i + 1} está incompleto: acción, cuándo (tipo y valor) y canal.`);
    }
    return { orden: i + 1, accion, cuando: { tipo: cuando.tipo, valor: texto(cuando.valor) }, canal: o.canal, quePedir: textoONull(o.que_pedir), requiereErnesto: o.requiere_ernesto === true, cita: textoONull(o.cita) };
  });
}

// ---------------------------------------------------------------------------------------------
// Acierto
// ---------------------------------------------------------------------------------------------

export interface CasoRevisado {
  origen: Origen;
  estado: EstadoValidacion;
  coincide: boolean;
  sdr: PropuestaResumida;
  ia: PropuestaResumida;
  /** Lo que quedó tras la revisión de Ernesto (confirmada o corregida). */
  final: PropuestaResumida | null;
}

export interface FilaAcierto {
  actor: 'coincidentes' | 'sdr' | 'ia';
  revisados: number;
  aciertos: number;
  /** Porcentaje redondeado al entero, o null si aún no hay casos revisados. */
  porcentaje: number | null;
}

const porcentaje = (aciertos: number, revisados: number): number | null => (revisados === 0 ? null : Math.round((aciertos / revisados) * 100));
const igual = (a: PropuestaResumida, b: PropuestaResumida): boolean => a.decision === b.decision && a.motivoCodigo === b.motivoCodigo;

/**
 * Acierto del piloto, solo con casos nuevos ya revisados por Ernesto (los históricos de la calibración no suman):
 * - coincidentes: de los casos en que SDR e IA coincidieron, en cuántos Ernesto confirmó decisión y motivo;
 * - sdr / ia: de todos los casos revisados, en cuántos la decisión y el motivo de ese actor son los finales de Ernesto.
 * Los próximos pasos no cuentan.
 */
export function calcularAcierto(casos: readonly CasoRevisado[]): FilaAcierto[] {
  const revisados = casos.filter((c) => c.origen === 'nuevo' && c.estado !== 'pendiente_ernesto' && c.final !== null);
  const coincidentes = revisados.filter((c) => c.coincide);
  const aciertosCoincidentes = coincidentes.filter((c) => c.estado === 'validada').length;
  const deActor = (clave: 'sdr' | 'ia'): FilaAcierto => {
    const aciertos = revisados.filter((c) => igual(c[clave], c.final as PropuestaResumida)).length;
    return { actor: clave, revisados: revisados.length, aciertos, porcentaje: porcentaje(aciertos, revisados.length) };
  };
  return [
    { actor: 'coincidentes', revisados: coincidentes.length, aciertos: aciertosCoincidentes, porcentaje: porcentaje(aciertosCoincidentes, coincidentes.length) },
    deActor('sdr'),
    deActor('ia'),
  ];
}
