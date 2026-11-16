// N-1.2 · Matriz de Alex y configuración de la agregación (ticket 869fny1eg).
// Son los valores propuestos del ticket y quedan en configuración (tablas criterio_config y
// agregacion_config), no repartidos por el código: cambiar un peso o un corte es una versión nueva.

export const NIVELES = ['A', 'B', 'C', 'D'] as const;
export type Nivel = (typeof NIVELES)[number];
/** NE = «no evaluado»: sin información. No se inventa ni se penaliza. */
export type NivelONE = Nivel | 'NE';

export const CRITERIOS_IDS = [
  'presupuesto',
  'urgencia',
  'decisor',
  'alcance',
  'actitud',
  'encaje_lyn',
  'predisposicion_f2f3',
] as const;
export type CriterioId = (typeof CRITERIOS_IDS)[number];

export interface CriterioConfig {
  criterioId: CriterioId;
  nombre: string;
  /** Etiqueta del campo «Desglose de calificación» (ej. «Pres A · Urg B»). */
  etiqueta: string;
  /** Peso en porcentaje entero (los 7 suman 100). */
  peso: number;
  descriptores: Record<Nivel, string>;
  orden: number;
}

export const MATRIZ_V1: readonly CriterioConfig[] = [
  {
    criterioId: 'presupuesto', nombre: 'Presupuesto', etiqueta: 'Pres', peso: 25, orden: 1,
    descriptores: { A: 'Encaja cómodo', B: 'Encaja, pero hay que ajustar', C: 'Justo', D: 'Muy justo' },
  },
  {
    criterioId: 'urgencia', nombre: 'Urgencia', etiqueta: 'Urg', peso: 25, orden: 2,
    descriptores: { A: '0–3 meses', B: '3–6 meses', C: '6–12 meses', D: 'Más de 12 meses' },
  },
  {
    criterioId: 'decisor', nombre: 'Decisor', etiqueta: 'Dec', peso: 15, orden: 3,
    descriptores: {
      A: 'Decide él/ella o pareja alineada',
      B: 'Falta validar algo menor',
      C: 'Pareja o familia influye',
      D: 'No decide',
    },
  },
  {
    criterioId: 'alcance', nombre: 'Alcance', etiqueta: 'Alc', peso: 10, orden: 4,
    descriptores: {
      A: 'Reforma integral clara',
      B: 'Integral con algún ajuste',
      C: 'Global, pero recortable',
      D: 'Parcial encubierta',
    },
  },
  {
    criterioId: 'actitud', nombre: 'Actitud', etiqueta: 'Act', peso: 10, orden: 5,
    descriptores: { A: 'Muy implicado, responde rápido', B: 'Buena actitud', C: 'Interés medio', D: 'Frío o lento' },
  },
  {
    criterioId: 'encaje_lyn', nombre: 'Encaje LYN', etiqueta: 'Enc', peso: 10, orden: 6,
    descriptores: {
      A: 'Valora diseño, método y control',
      B: 'Entiende el valor',
      C: 'Compara mucho precio',
      D: 'Busca barato',
    },
  },
  {
    criterioId: 'predisposicion_f2f3', nombre: 'Predisposición a seguir F2/F3 en oficina', etiqueta: 'F2/F3', peso: 5, orden: 7,
    descriptores: {
      A: 'Acepta el proceso y concreta la próxima reunión',
      B: 'Acepta venir, pendiente de concretar fecha',
      C: 'Dudas («tengo que comentarlo en casa») o resistencia; no se compromete',
      D: 'Rechaza venir o seguir F2/F3',
    },
  },
];

export interface AgregacionConfig {
  puntos: Record<Nivel, number>;
  /** Cortes de la puntuación: ≥ corteA → A, ≥ corteB → B, ≥ corteC → C, y por debajo D. */
  corteA: number;
  corteB: number;
  corteC: number;
  /** Fracción mínima de pesos evaluados para poder calificar (0,5 = 50 %). */
  coberturaMinima: number;
  /** Presupuesto vigente (EUR) desde el que una A pasa a A+, si el criterio Presupuesto es A o B. */
  umbralAPlus: number;
  version: number;
}

export const AGREGACION_V1: AgregacionConfig = {
  puntos: { A: 4, B: 3, C: 2, D: 1 },
  corteA: 3.5,
  corteB: 2.5,
  corteC: 1.5,
  coberturaMinima: 0.5,
  umbralAPlus: 100_000,
  version: 1,
};

/** Bordes de la urgencia en meses (P-11, propuesta): ≤ a → A · ≤ b → B · ≤ c → C · más → D. */
export interface BordesUrgencia {
  a: number;
  b: number;
  c: number;
}
export const BORDES_URGENCIA_V1: BordesUrgencia = { a: 3, b: 6, c: 12 };

/**
 * Nivel provisional de Alcance a partir del formulario (pendiente de validar con Alex).
 * Las claves van normalizadas (minúsculas, sin tildes, espacios simples).
 */
export const ALCANCE_PROVISIONAL_V1: Readonly<Record<string, Nivel>> = {
  'reforma integral de vivienda': 'A',
  integral: 'A',
  'reforma global de vivienda (salvo algunas estancias)': 'C',
  'reforma de una estancia concreta': 'D',
  especifica: 'D',
};

/** Importe aceptable de un presupuesto extraído por el modelo; fuera de este rango va a revisión manual. */
export const LIMITES_IMPORTE = { min: 1_000, max: 5_000_000 } as const;

/** Mínimo de palabras de una cita (igual que el calificador interno de llamadas). */
export const MIN_PALABRAS_CITA = 4;
