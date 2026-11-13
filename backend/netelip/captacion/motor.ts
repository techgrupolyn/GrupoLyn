import {
  CAMPOS_PERMITIDOS,
  CONFIG_V1,
  ETIQUETA_FUENTE,
  ETIQUETA_SIN_PRESUPUESTO,
  MOTIVO_NO_CONTINUIDAD_PRESUPUESTO,
  UMBRAL_A_PLUS,
  type Categoria,
  type ConfigCategoria,
  type EventoPresupuesto,
  type Fuente,
  type Motivo,
  type TipoPresupuesto,
} from './tipos.ts';

// Lógica pura de N-1.1: no habla con ClickUp ni con la base de datos. Quien la use pasa los datos
// y guarda el resultado. Importes en EUR enteros.

const aMs = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Fecha no válida: ${iso}`);
  return t;
};

// ---------------------------------------------------------------------------------------------
// Presupuesto
// ---------------------------------------------------------------------------------------------

/**
 * Valor vigente de una mención: el importe si es exacto, el valor central si es un rango.
 * Los rangos abiertos («más de X») no tienen regla todavía (P-04 del épico): quien los registre
 * debe informar el valor vigente a mano.
 */
export function valorVigenteDe(p: {
  tipo: TipoPresupuesto;
  valorMin?: number | null;
  valorMax?: number | null;
}): number {
  const { tipo, valorMin, valorMax } = p;
  if (tipo === 'exacto') {
    if (valorMin == null || valorMin <= 0) throw new Error('Un presupuesto exacto necesita un importe mayor que 0');
    return valorMin;
  }
  if (tipo === 'rango') {
    if (valorMin == null || valorMax == null || valorMin <= 0) throw new Error('Un rango necesita mínimo y máximo mayores que 0');
    if (valorMin > valorMax) throw new Error('El mínimo del rango no puede superar al máximo');
    return Math.round((valorMin + valorMax) / 2);
  }
  throw new Error('Rango abierto: la regla del valor vigente está pendiente (P-04); informa valorVigente a mano');
}

export interface DatosEvento {
  id: string;
  fuente: Fuente;
  tipo: TipoPresupuesto;
  valorMin?: number | null;
  valorMax?: number | null;
  valorVigente?: number;
  fechaInteraccion: string;
  creadoEn: string;
  registradoPor: 'sistema' | 'ia' | 'usuario';
  usuarioId?: string | null;
  interaccionId?: string | null;
  citaTextual?: string | null;
  emisor?: 'cliente' | 'lyn';
}

/** Arma un evento de presupuesto, calculando el valor vigente si no se informa. */
export function crearEventoPresupuesto(d: DatosEvento): EventoPresupuesto {
  const valorVigente = d.valorVigente ?? valorVigenteDe(d);
  if (!(valorVigente > 0)) throw new Error('El valor vigente debe ser mayor que 0');
  return {
    id: d.id,
    fuente: d.fuente,
    tipo: d.tipo,
    valorMin: d.valorMin ?? null,
    valorMax: d.valorMax ?? null,
    valorVigente,
    fechaInteraccion: d.fechaInteraccion,
    creadoEn: d.creadoEn,
    registradoPor: d.registradoPor,
    usuarioId: d.usuarioId ?? null,
    interaccionId: d.interaccionId ?? null,
    citaTextual: d.citaTextual ?? null,
    ...(d.emisor ? { emisor: d.emisor } : {}),
  };
}

/**
 * ¿Esta mención cuenta como presupuesto del lead? Lo que dice el lead (o el formulario, o un comercial a mano) sí.
 * Una cifra que dice LYN en una llamada, reunión o WhatsApp es una referencia del comercial (puede ser el precio de un
 * producto o una horquilla de catálogo): se guarda, pero no cuenta. La de la propuesta de la Fase 2 de LYN sí cuenta.
 */
export const cuentaComoPresupuesto = (e: EventoPresupuesto): boolean => !(e.emisor === 'lyn' && e.fuente !== 'fase2_lyn');

/**
 * Presupuesto vigente de un lead: el evento de la interacción más reciente que cuenta (RN-8). Un evento
 * antiguo procesado tarde queda guardado pero no pisa al vigente, y una cifra de LYN no pisa a la del cliente.
 * Un importe 0 cuenta como vacío.
 */
export function presupuestoVigente(eventos: readonly EventoPresupuesto[]): EventoPresupuesto | null {
  const validos = eventos.filter((e) => Number.isFinite(e.valorVigente) && e.valorVigente > 0 && cuentaComoPresupuesto(e));
  if (validos.length === 0) return null;
  const ordenados = [...validos].sort(
    (a, b) => aMs(b.fechaInteraccion) - aMs(a.fechaInteraccion) || aMs(b.creadoEn) - aMs(a.creadoEn),
  );
  return ordenados[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Categoría y ponderado
// ---------------------------------------------------------------------------------------------

export interface EntradaCategoria {
  /** Categoría que hoy tiene la tarea (la eligió el comercial o la escribió el sistema). */
  categoriaElegida: Categoria | null;
  presupuesto: number | null;
  noContinuidad?: string | null;
  /**
   * N-1.2: una A solo es A+ si el criterio Presupuesto de la matriz es A o B. Con `false` la A se
   * queda en A aunque el importe llegue a 100.000 €. Sin informar (lead sin evaluaciones, N-1.1 solo),
   * basta el importe.
   */
  aPlusPermitido?: boolean;
  /** Importe desde el que una A pasa a A+. Por defecto, el de la configuración v1 (100.000 €). */
  umbralAPlus?: number;
}

export interface ResultadoCategoria {
  categoria: Categoria;
  /** Se informa cuando se eligió A+ sin el importe y el sistema la dejó en A. */
  correccion?: { intento: Categoria };
}

/**
 * Categoría final: A+ es una A con presupuesto vigente de 100.000 € o más; sin ese importe vuelve a A.
 * No apto manda sobre todo, y «No continuidad = Presupuesto insuficiente» equivale a No apto.
 */
export function categoriaFinal(e: EntradaCategoria): ResultadoCategoria {
  if (e.noContinuidad === MOTIVO_NO_CONTINUIDAD_PRESUPUESTO) return { categoria: 'no_apto' };
  const elegida = e.categoriaElegida;
  if (elegida === null || elegida === 'sin_calificar') return { categoria: 'sin_calificar' };
  if (elegida === 'no_apto') return { categoria: 'no_apto' };
  if (elegida === 'A' || elegida === 'A+') {
    const umbral = e.umbralAPlus ?? UMBRAL_A_PLUS;
    const llegaAAPlus = e.aPlusPermitido !== false && e.presupuesto !== null && e.presupuesto >= umbral;
    if (llegaAAPlus) return { categoria: 'A+' };
    return elegida === 'A+' ? { categoria: 'A', correccion: { intento: 'A+' } } : { categoria: 'A' };
  }
  return { categoria: elegida };
}

export interface Ponderado {
  factor: number | null;
  ponderado: number | null;
}

/** Presupuesto x factor de la categoría, redondeado al euro. No apto da 0; sin presupuesto o sin factor, vacío. */
export function ponderadoDe(
  categoria: Categoria,
  presupuesto: number | null,
  config: readonly ConfigCategoria[] = CONFIG_V1,
): Ponderado {
  const factor = config.find((c) => c.categoria === categoria)?.valorPonderado ?? null;
  if (factor === 0) return { factor: 0, ponderado: 0 };
  if (factor === null || presupuesto === null) return { factor, ponderado: null };
  // Aritmética en centésimas para no arrastrar errores de coma flotante (0,45 x 10 = 4,5 exacto).
  const centesimas = Math.round(factor * 100);
  return { factor, ponderado: Math.round((presupuesto * centesimas) / 100) };
}

// ---------------------------------------------------------------------------------------------
// Calificación completa de un lead
// ---------------------------------------------------------------------------------------------

/** Qué provocó el recálculo. Decide qué fila (si alguna) se agrega al histórico. */
export type Disparador = 'alta' | 'categoria_manual' | 'presupuesto' | 'recalculo' | 'evaluacion_ia';

/** Última fila del histórico del lead. Los campos opcionales solo se comparan si se informan. */
export interface EstadoPrevio {
  categoria: Categoria;
  presupuestoVigente: number | null;
  ponderado?: number | null;
  puntuacion?: number | null;
  cobertura?: number | null;
  versionConfig?: number;
}

export interface EntradaCalificacion {
  eventos: readonly EventoPresupuesto[];
  categoriaElegida: Categoria | null;
  noContinuidad?: string | null;
  previo: EstadoPrevio | null;
  disparador: Disparador;
  config?: readonly ConfigCategoria[];
  versionConfig?: number;
  /** N-1.2: ver `EntradaCategoria.aPlusPermitido`. Se informa siempre que el lead tenga evaluaciones. */
  aPlusPermitido?: boolean;
  /**
   * N-1.2: puntuación y cobertura de la matriz. Se informa cuando `categoriaElegida` es la categoría que
   * calculó la matriz (disparador `evaluacion_ia`, o `recalculo` de un lead calificado por la matriz):
   * quedan en las filas del histórico.
   */
  evaluacion?: { puntuacion: number | null; cobertura: number };
  umbralAPlus?: number;
}

export interface FilaHistorial {
  categoria: Categoria;
  presupuestoVigente: number | null;
  valorPonderado: number | null;
  ponderado: number | null;
  motivo: Motivo;
  eventoPresupuestoId: string | null;
  versionConfig: number;
  /** Solo en las filas que salen de una evaluación de N-1.2. */
  puntuacion?: number | null;
  cobertura?: number | null;
}

/** Lo único que el sistema escribe en la tarea de ClickUp. */
export interface EscriturasClickUp {
  categoria: Categoria;
  presupuesto: number | null;
  ponderado: number | null;
  fuente_presupuesto: string;
}

export interface Calificacion {
  categoria: Categoria;
  presupuestoVigente: number | null;
  eventoVigenteId: string | null;
  factor: number | null;
  ponderado: number | null;
  fuentePresupuesto: string;
  escrituras: EscriturasClickUp;
  historial: FilaHistorial[];
}

export function calificar(e: EntradaCalificacion): Calificacion {
  const config = e.config ?? CONFIG_V1;
  const versionConfig = e.versionConfig ?? 1;
  const vigente = presupuestoVigente(e.eventos);
  const presupuesto = vigente ? vigente.valorVigente : null;
  const resultado = categoriaFinal({
    categoriaElegida: e.categoriaElegida,
    presupuesto,
    noContinuidad: e.noContinuidad,
    aPlusPermitido: e.aPlusPermitido,
    umbralAPlus: e.umbralAPlus,
  });
  const { factor, ponderado } = ponderadoDe(resultado.categoria, presupuesto, config);
  const fuentePresupuesto = vigente ? ETIQUETA_FUENTE[vigente.fuente] : ETIQUETA_SIN_PRESUPUESTO;

  const fila = (categoria: Categoria, motivo: Motivo): FilaHistorial => {
    const p = ponderadoDe(categoria, presupuesto, config);
    return {
      categoria,
      presupuestoVigente: presupuesto,
      valorPonderado: p.factor,
      ponderado: p.ponderado,
      motivo,
      eventoPresupuestoId: vigente?.id ?? null,
      versionConfig,
      ...(e.evaluacion ? { puntuacion: e.evaluacion.puntuacion, cobertura: e.evaluacion.cobertura } : {}),
    };
  };

  const historial: FilaHistorial[] = [];
  const previo = e.previo;
  // Un dato del estado anterior que no se informó (undefined) no cuenta como cambio.
  const cambia = <T>(antes: T | undefined, ahora: T): boolean => antes !== undefined && antes !== ahora;
  if (previo === null || e.disparador === 'alta') {
    // Un lead sin histórico que entra directamente por una llamada evaluada queda como evaluacion_ia.
    historial.push(fila(resultado.categoria, e.disparador === 'evaluacion_ia' ? 'evaluacion_ia' : 'alta'));
  } else if (e.disparador === 'categoria_manual') {
    if (resultado.correccion) {
      // El intento y la corrección quedan como dos filas seguidas.
      historial.push(fila(resultado.correccion.intento, 'cambio_categoria_manual'));
      historial.push(fila(resultado.categoria, 'cambio_categoria_manual'));
    } else if (resultado.categoria !== previo.categoria) {
      historial.push(fila(resultado.categoria, 'cambio_categoria_manual'));
    }
  } else {
    const cambioBase = resultado.categoria !== previo.categoria || presupuesto !== previo.presupuestoVigente;
    const cambioEvaluacion =
      e.evaluacion !== undefined &&
      (cambia(previo.puntuacion, e.evaluacion.puntuacion) || cambia(previo.cobertura, e.evaluacion.cobertura));
    if (e.disparador === 'presupuesto') {
      if (cambioBase) historial.push(fila(resultado.categoria, 'cambio_presupuesto'));
    } else if (e.disparador === 'evaluacion_ia') {
      // Reprocesar la misma llamada no cambia nada y no agrega filas.
      if (cambioBase || cambioEvaluacion) historial.push(fila(resultado.categoria, 'evaluacion_ia'));
    } else if (
      cambioBase ||
      cambioEvaluacion ||
      cambia(previo.ponderado, ponderado) ||
      cambia(previo.versionConfig, versionConfig)
    ) {
      // Recálculo por cambio de configuración: deja constancia de la versión aunque el resultado no cambie.
      historial.push(fila(resultado.categoria, 'recalculo_config'));
    }
  }

  return {
    categoria: resultado.categoria,
    presupuestoVigente: presupuesto,
    eventoVigenteId: vigente?.id ?? null,
    factor,
    ponderado,
    fuentePresupuesto,
    escrituras: { categoria: resultado.categoria, presupuesto, ponderado, fuente_presupuesto: fuentePresupuesto },
    historial,
  };
}

// ---------------------------------------------------------------------------------------------
// Límites de escritura y eventos que se descartan
// ---------------------------------------------------------------------------------------------

/** Rechaza cualquier escritura fuera de los campos permitidos (no se toca ETAPA_CRM, estado, fecha de inicio ni título). */
export function validarEscrituras<T extends object>(cambios: T): T {
  const permitidos: readonly string[] = CAMPOS_PERMITIDOS;
  const noPermitidos = Object.keys(cambios).filter((k) => !permitidos.includes(k));
  if (noPermitidos.length > 0) throw new Error(`Campos no permitidos: ${noPermitidos.join(', ')}`);
  return cambios;
}

export interface EventoWebhook {
  /** Id de la tarea madre; null si es una tarea padre. */
  parentId: string | null;
  usuarioId: string;
}

export type DecisionWebhook =
  | { procesar: true }
  | { procesar: false; motivo: 'subtarea' | 'escritura_del_sistema' };

/** Solo se procesan tareas padre, y se descartan los eventos que el propio usuario de integración provocó. */
export function decidirWebhook(e: EventoWebhook, usuarioIntegracionId: string): DecisionWebhook {
  if (e.parentId !== null) return { procesar: false, motivo: 'subtarea' };
  if (e.usuarioId === usuarioIntegracionId) return { procesar: false, motivo: 'escritura_del_sistema' };
  return { procesar: true };
}

// ---------------------------------------------------------------------------------------------
// Orden de la vista «Por potencial»
// ---------------------------------------------------------------------------------------------

/** A+, A, B, C, D, Sin calificar, No apto; dentro de cada una, ponderado de mayor a menor y los vacíos al final. */
export function ordenarPorPotencial<T extends { categoria: Categoria; ponderado: number | null }>(
  leads: readonly T[],
  config: readonly ConfigCategoria[] = CONFIG_V1,
): T[] {
  const orden = (c: Categoria): number => config.find((x) => x.categoria === c)?.orden ?? Number.MAX_SAFE_INTEGER;
  return [...leads].sort((a, b) => {
    const porCategoria = orden(a.categoria) - orden(b.categoria);
    if (porCategoria !== 0) return porCategoria;
    if (a.ponderado === b.ponderado) return 0;
    if (a.ponderado === null) return 1;
    if (b.ponderado === null) return -1;
    return b.ponderado - a.ponderado;
  });
}

// ---------------------------------------------------------------------------------------------
// Carga inicial
// ---------------------------------------------------------------------------------------------

export interface TareaCarga {
  id: string;
  parentId: string | null;
  categoriaElegida: Categoria | null;
  noContinuidad?: string | null;
  /** Valor actual de presupuesto_estimado en ClickUp. 0 o vacío cuenta como sin presupuesto. */
  presupuestoClickUp: number | null;
}

export interface AltaCarga {
  clickupTaskId: string;
  eventoNuevo: EventoPresupuesto | null;
  calificacion: Calificacion;
}

export interface PlanCarga {
  altas: AltaCarga[];
  /** Leads que quedan sin presupuesto: el listado que se entrega. */
  sinPresupuesto: string[];
  omitidas: { id: string; motivo: 'subtarea' | 'ya_cargada' }[];
}

/**
 * Plan de la carga inicial. Solo tareas padre; una tarea ya cargada se omite, así que correrla
 * dos veces no duplica nada. El importe que ya existe en ClickUp se registra como evento «manual».
 */
export function planificarCargaInicial(
  tareas: readonly TareaCarga[],
  yaCargadas: ReadonlySet<string>,
  opciones: { fechaCarga: string; idEvento: (idTarea: string) => string },
): PlanCarga {
  const plan: PlanCarga = { altas: [], sinPresupuesto: [], omitidas: [] };
  for (const t of tareas) {
    if (t.parentId !== null) {
      plan.omitidas.push({ id: t.id, motivo: 'subtarea' });
      continue;
    }
    if (yaCargadas.has(t.id)) {
      plan.omitidas.push({ id: t.id, motivo: 'ya_cargada' });
      continue;
    }
    const importe = t.presupuestoClickUp !== null && t.presupuestoClickUp > 0 ? t.presupuestoClickUp : null;
    const eventoNuevo =
      importe === null
        ? null
        : crearEventoPresupuesto({
            id: opciones.idEvento(t.id),
            fuente: 'manual',
            tipo: 'exacto',
            valorMin: importe,
            valorMax: importe,
            fechaInteraccion: opciones.fechaCarga,
            creadoEn: opciones.fechaCarga,
            registradoPor: 'sistema',
            interaccionId: `carga-inicial:${t.id}`,
          });
    const calificacion = calificar({
      eventos: eventoNuevo ? [eventoNuevo] : [],
      categoriaElegida: t.categoriaElegida,
      noContinuidad: t.noContinuidad,
      previo: null,
      disparador: 'alta',
    });
    plan.altas.push({ clickupTaskId: t.id, eventoNuevo, calificacion });
    if (importe === null) plan.sinPresupuesto.push(t.id);
  }
  return plan;
}
