export const CATEGORIAS = ['A+', 'A', 'B', 'C', 'D', 'sin_calificar', 'no_apto'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const FUENTES = ['formulario', 'llamada_netelip', 'reunion_meet', 'whatsapp', 'fase2_lyn', 'manual'] as const;
export type Fuente = (typeof FUENTES)[number];

export const TIPOS_PRESUPUESTO = ['exacto', 'rango', 'abierto_superior', 'abierto_inferior'] as const;
export type TipoPresupuesto = (typeof TIPOS_PRESUPUESTO)[number];

export type Motivo =
  | 'alta'
  | 'cambio_presupuesto'
  | 'cambio_categoria_manual'
  | 'evaluacion_ia'
  | 'recalculo_config';

/** Una mención de presupuesto. Las fechas son ISO 8601. */
export interface EventoPresupuesto {
  id: string;
  fuente: Fuente;
  tipo: TipoPresupuesto;
  valorMin: number | null;
  valorMax: number | null;
  valorVigente: number;
  fechaInteraccion: string;
  creadoEn: string;
  registradoPor: 'sistema' | 'ia' | 'usuario';
  usuarioId?: string | null;
  interaccionId?: string | null;
  citaTextual?: string | null;
  /**
   * Quién dijo la cifra. Cuentan las dos: la del cliente y la que da el comercial («lyn») para toda la reforma, salvo
   * una cifra pequeña de LYN, que es una ampliación o un extra y se guarda sin contar. Sin informar (N-1.1 solo) cuenta.
   */
  emisor?: 'cliente' | 'lyn';
}

export interface ConfigCategoria {
  categoria: Categoria;
  valorPonderado: number | null;
  orden: number;
}

/** Versión 1 de categoria_config (RN-3). Es la misma que siembra el SQL. */
export const CONFIG_V1: readonly ConfigCategoria[] = [
  { categoria: 'A+', valorPonderado: 1, orden: 1 },
  { categoria: 'A', valorPonderado: 1, orden: 2 },
  { categoria: 'B', valorPonderado: 0.75, orden: 3 },
  { categoria: 'C', valorPonderado: 0.45, orden: 4 },
  { categoria: 'D', valorPonderado: 0.15, orden: 5 },
  { categoria: 'sin_calificar', valorPonderado: null, orden: 6 },
  { categoria: 'no_apto', valorPonderado: 0, orden: 7 },
];

/** Presupuesto vigente mínimo (en EUR) para que una A pase a A+. */
export const UMBRAL_A_PLUS = 100_000;

export const MOTIVO_NO_CONTINUIDAD_PRESUPUESTO = 'Presupuesto insuficiente';
export const ETIQUETA_SIN_PRESUPUESTO = 'Pendiente: preguntar en la 1ª llamada';

/** Cómo se muestra cada fuente en el desplegable «Fuente del presupuesto» de ClickUp. */
export const ETIQUETA_FUENTE: Record<Fuente, string> = {
  formulario: 'Formulario',
  llamada_netelip: 'Llamada',
  reunion_meet: 'Reunión',
  whatsapp: 'WhatsApp',
  fase2_lyn: 'Fase 2 LYN',
  manual: 'Manual',
};

/** Cómo se muestra cada categoría en el desplegable «Categoría» de ClickUp. */
export const ETIQUETA_CATEGORIA: Record<Categoria, string> = {
  'A+': 'A+',
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  sin_calificar: 'Sin calificar',
  no_apto: 'No apto',
};

/**
 * Únicos campos que el sistema puede escribir en una tarea de ClickUp. `desglose` es el campo nuevo
 * «Desglose de calificación» de N-1.2 (texto corto, solo lo escribe el sistema).
 */
export const CAMPOS_PERMITIDOS = ['categoria', 'presupuesto', 'ponderado', 'fuente_presupuesto', 'indice_orden', 'desglose'] as const;
