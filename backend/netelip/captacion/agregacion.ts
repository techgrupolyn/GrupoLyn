import {
  AGREGACION_V1,
  ALCANCE_PROVISIONAL_V1,
  BORDES_URGENCIA_V1,
  CRITERIOS_IDS,
  MATRIZ_V1,
  type AgregacionConfig,
  type BordesUrgencia,
  type CriterioConfig,
  type CriterioId,
  type Nivel,
  type NivelONE,
} from './matriz.ts';
import type { Categoria } from './tipos.ts';

// Lógica pura de N-1.2: niveles por criterio, No apto, puntuación, cobertura, categoría global y A+.
// No habla con la base de datos, con ClickUp ni con el modelo. Aritmética entera: nada de coma
// flotante en las decisiones (un 3,4999 no puede redondearse a 3,50 y subir de B a A).

const aMs = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Fecha no válida: ${iso}`);
  return t;
};

/** Minúsculas, sin tildes y con espacios simples. */
export function normalizarTexto(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Urgencia y Alcance provisional (deterministas)
// ---------------------------------------------------------------------------------------------

/**
 * Nivel de Urgencia a partir del plazo en meses que extrae el modelo (el código asigna el nivel).
 * Sin plazo, o con un plazo que no es un número ≥ 0, es NE.
 */
export function nivelUrgencia(plazoMeses: number | null | undefined, bordes: BordesUrgencia = BORDES_URGENCIA_V1): NivelONE {
  if (plazoMeses === null || plazoMeses === undefined) return 'NE';
  if (typeof plazoMeses !== 'number' || !Number.isFinite(plazoMeses) || plazoMeses < 0) return 'NE';
  if (plazoMeses <= bordes.a) return 'A';
  if (plazoMeses <= bordes.b) return 'B';
  if (plazoMeses <= bordes.c) return 'C';
  return 'D';
}

/**
 * Clave para comparar el tipo de reforma o de contacto del formulario. En ClickUp las opciones de
 * «Tipo de Contacto» llegan con guiones bajos y a veces con una explicación detrás
 * («Reforma_de_una_estancia_concreta:_cocina,_baño_u_otra_zona»): se pasan a espacios y se quitan los
 * dos puntos y las comas.
 */
const claveAlcance = (valor: unknown): string => normalizarTexto(valor).replace(/[_:,]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Nivel provisional de Alcance desde el formulario, antes de la primera llamada. Manda el tipo de
 * reforma; si no se reconoce, el tipo de contacto. Coincide con una clave entera o con el comienzo del
 * valor (gana la clave más larga). Sin correspondencia es NE (no se inventa): «REFORMA» a secas y
 * «Parcial» no dicen el alcance y no se mapean.
 */
export function nivelAlcanceProvisional(
  datos: { tipoReforma?: string | null; tipoContacto?: string | null },
  mapa: Readonly<Record<string, Nivel>> = ALCANCE_PROVISIONAL_V1,
): NivelONE {
  const claves = Object.keys(mapa).sort((a, b) => b.length - a.length);
  for (const valor of [datos.tipoReforma, datos.tipoContacto]) {
    const clave = claveAlcance(valor);
    if (!clave) continue;
    const llave = claves.find((k) => clave === k || clave.startsWith(`${k} `));
    if (llave !== undefined) return mapa[llave] as Nivel;
  }
  return 'NE';
}

// ---------------------------------------------------------------------------------------------
// Nivel vigente de cada criterio
// ---------------------------------------------------------------------------------------------

export interface EvaluacionCriterio {
  criterioId: CriterioId;
  nivel: NivelONE;
  origen: 'llamada' | 'formulario_provisional';
  cita: string | null;
  fechaInteraccion: string;
  creadoEn: string;
}

const masReciente = <T extends { fechaInteraccion: string; creadoEn: string }>(filas: readonly T[]): T => {
  const ordenadas = [...filas].sort(
    (a, b) => aMs(b.fechaInteraccion) - aMs(a.fechaInteraccion) || aMs(b.creadoEn) - aMs(a.creadoEn),
  );
  return ordenadas[0] as T;
};

const tieneCita = (cita: string | null): boolean => cita !== null && cita.trim() !== '';

/**
 * Nivel vigente de UN criterio: el de la llamada más reciente (por fecha de la interacción) con
 * evidencia citada. Una llamada que no aporta información (NE) conserva el nivel anterior. El nivel
 * provisional del formulario solo vale mientras ninguna llamada lo haya sustituido.
 */
export function nivelVigente(evaluaciones: readonly EvaluacionCriterio[]): NivelONE {
  const deLlamada = evaluaciones.filter((e) => e.origen === 'llamada' && e.nivel !== 'NE' && tieneCita(e.cita));
  if (deLlamada.length > 0) return masReciente(deLlamada).nivel;
  const provisionales = evaluaciones.filter((e) => e.origen === 'formulario_provisional' && e.nivel !== 'NE');
  if (provisionales.length > 0) return masReciente(provisionales).nivel;
  return 'NE';
}

/** Nivel vigente de los 7 criterios (NE si no hay ninguna evaluación). */
export function nivelesVigentes(evaluaciones: readonly EvaluacionCriterio[]): Record<CriterioId, NivelONE> {
  const resultado = {} as Record<CriterioId, NivelONE>;
  for (const id of CRITERIOS_IDS) resultado[id] = nivelVigente(evaluaciones.filter((e) => e.criterioId === id));
  return resultado;
}

// ---------------------------------------------------------------------------------------------
// No apto
// ---------------------------------------------------------------------------------------------

export interface EventoNoApto {
  valor: boolean;
  cita: string | null;
  registradoPor: 'ia' | 'usuario';
  fechaInteraccion: string;
  creadoEn: string;
}

/**
 * ¿Hay un No apto vigente? Cuenta el evento válido más reciente. Un evento de la IA exige cita, tanto
 * para marcarlo como para levantarlo («si una llamada posterior lo contradice con cita»); el comercial
 * puede marcarlo o quitarlo a mano sin cita.
 */
export function noAptoVigente(eventos: readonly EventoNoApto[]): boolean {
  const validos = eventos.filter((e) => e.registradoPor === 'usuario' || tieneCita(e.cita));
  if (validos.length === 0) return false;
  return masReciente(validos).valor;
}

// ---------------------------------------------------------------------------------------------
// Categoría global
// ---------------------------------------------------------------------------------------------

export interface EntradaAgregacion {
  niveles: Record<CriterioId, NivelONE>;
  noApto: boolean;
  /** Presupuesto vigente de N-1.1 (EUR), o null si el lead aún no tiene. */
  presupuestoVigente: number | null;
  matriz?: readonly CriterioConfig[];
  config?: AgregacionConfig;
}

export interface ResultadoAgregacion {
  /** Puede ser A+, no_apto o sin_calificar además de A, B, C, D. */
  categoria: Categoria;
  niveles: Record<CriterioId, NivelONE>;
  /** 0,00 a 4,00 con dos decimales; null si no hay ningún criterio evaluado. */
  puntuacion: number | null;
  /** Porcentaje de pesos evaluados, 0 a 100. */
  cobertura: number;
  /** Texto del campo «Desglose de calificación». */
  desglose: string;
  motivo: 'no_apto' | 'cobertura_insuficiente' | 'puntuacion';
  /** El criterio Presupuesto es A o B: condición (junto con el importe) para que una A sea A+. */
  aPlusPermitido: boolean;
}

const centesimas = (x: number): number => Math.round(x * 100);
const conComa = (n: number): string => n.toFixed(2).replace('.', ',');

/** Orden de decisión: No apto → cobertura insuficiente → cortes de la puntuación → A+. */
export function calcularCategoria(e: EntradaAgregacion): ResultadoAgregacion {
  const matriz = e.matriz ?? MATRIZ_V1;
  const config = e.config ?? AGREGACION_V1;

  let pesoTotal = 0;
  let sumaPesos = 0;
  let sumaPesoPuntos = 0;
  for (const c of matriz) {
    if (!Number.isInteger(c.peso) || c.peso < 0) throw new Error(`Peso no válido en ${c.criterioId}: ${c.peso}`);
    pesoTotal += c.peso;
    const nivel = e.niveles[c.criterioId] ?? 'NE';
    if (nivel !== 'NE') {
      sumaPesos += c.peso;
      sumaPesoPuntos += c.peso * config.puntos[nivel];
    }
  }
  if (pesoTotal <= 0) throw new Error('La matriz no tiene pesos');

  // Puntuación a dos decimales (mitad hacia arriba) sin coma flotante; las decisiones usan el valor exacto.
  const puntuacion =
    sumaPesos > 0 ? Math.floor((2 * sumaPesoPuntos * 100 + sumaPesos) / (2 * sumaPesos)) / 100 : null;
  const cobertura = Math.round((sumaPesos * 10_000) / pesoTotal) / 100;

  const nivelPresupuesto = e.niveles.presupuesto ?? 'NE';
  const aPlusPermitido = nivelPresupuesto === 'A' || nivelPresupuesto === 'B';

  const cobertura_insuficiente = sumaPesos * 100 < centesimas(config.coberturaMinima) * pesoTotal;
  let categoria: Categoria;
  let motivo: ResultadoAgregacion['motivo'];
  if (e.noApto) {
    categoria = 'no_apto';
    motivo = 'no_apto';
  } else if (cobertura_insuficiente) {
    categoria = 'sin_calificar';
    motivo = 'cobertura_insuficiente';
  } else {
    motivo = 'puntuacion';
    if (sumaPesoPuntos * 100 >= centesimas(config.corteA) * sumaPesos) categoria = 'A';
    else if (sumaPesoPuntos * 100 >= centesimas(config.corteB) * sumaPesos) categoria = 'B';
    else if (sumaPesoPuntos * 100 >= centesimas(config.corteC) * sumaPesos) categoria = 'C';
    else categoria = 'D';
    if (categoria === 'A' && aPlusPermitido && e.presupuestoVigente !== null && e.presupuestoVigente >= config.umbralAPlus) {
      categoria = 'A+';
    }
  }

  const partes = [...matriz]
    .sort((a, b) => a.orden - b.orden)
    .map((c) => `${c.etiqueta} ${e.niveles[c.criterioId] ?? 'NE'}`);
  const textoCobertura = String(cobertura).replace('.', ',');
  const desglose = [...partes, puntuacion === null ? '–' : conComa(puntuacion), `cob. ${textoCobertura} %`].join(' · ');

  return { categoria, niveles: e.niveles, puntuacion, cobertura, desglose, motivo, aPlusPermitido };
}
