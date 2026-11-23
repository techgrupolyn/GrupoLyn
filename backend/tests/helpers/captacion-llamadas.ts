// Llamadas de prueba para la captación ABCD: transcripciones con frases conocidas y la salida del «modelo»
// que las cita literalmente. Sin red.
export const FRASE = {
  presupuesto: 'Tenemos pensado entre noventa y ciento diez mil euros para la obra',
  urgencia: 'La idea es empezar en unos dos meses, en cuanto firmemos la compra',
  decisor: 'Lo decidimos mi marido y yo, y los dos lo tenemos clarísimo',
  alcance: 'Queremos reformar la vivienda entera, de arriba abajo',
};

/** Transcripción con turnos en el formato del repo (`[hh:mm:ss] ROL: texto`). */
export const TRANSCRIPCION_BASE = [
  '[00:00:05] GRUPO LYN: Hola, soy Laura de Grupo LYN, te llamo por la reforma que nos consultaste.',
  `[00:01:10] CLIENTE: ${FRASE.urgencia}.`,
  `[00:01:40] CLIENTE: ${FRASE.decisor}.`,
  `[00:02:10] CLIENTE: ${FRASE.presupuesto}.`,
].join('\n');

const NE = { nivel: 'NE', cita: null, marca_tiempo: null };

export interface OpcionesSalida {
  /** Niveles distintos a los de la llamada «buena» (todo A con 2 meses de plazo). */
  nivelDecisor?: 'A' | 'B' | 'C' | 'D';
  plazoMeses?: number;
  /** Rango de presupuesto; por defecto 90.000–110.000. */
  presupuesto?: { min: number; max: number } | null;
  /** Quién dice el importe: por defecto el cliente. Con «lyn» es una cifra del comercial (no cuenta como presupuesto). */
  emisor?: 'cliente' | 'lyn';
  /** Cita del criterio Decisor; por defecto la frase real. Una que no está en la llamada se descarta. */
  citaDecisor?: string;
  /** Marca «presupuesto insuficiente sin solución» con una cita que no está en la llamada (va a revisión manual). */
  noAptoInventado?: boolean;
  /** Resumen ejecutivo que devuelve el «modelo» (N-1.3). Por defecto, vacío: el resumen no se guarda. */
  resumen?: Partial<ResumenDelModelo>;
  /** decision_ia que devuelve el «modelo» (N-1.4), tal cual. Por defecto no devuelve ninguna. */
  decisionIA?: unknown;
}

export interface ResumenDelModelo {
  que_quiere: string;
  donde_quedo: string;
  que_lo_frena: string;
  para_que_llamarlo: string;
  fecha_prevista: string | null;
  fecha_prevista_cita: string | null;
}

/** Una frase que SÍ está en TRANSCRIPCION_CON_FECHA: sirve de cita para la fecha prevista del resumen. */
export const CITA_FECHA = 'Nos vemos el viernes veinte a las seis en la oficina';
/** TRANSCRIPCION_BASE más un turno en el que el lead acuerda una fecha (el viernes 20 de noviembre de 2026). */
export const TRANSCRIPCION_CON_FECHA = `${TRANSCRIPCION_BASE}\n[00:02:40] CLIENTE: ${CITA_FECHA}.`;

/** Resumen correcto para una llamada del 17/11/2026 con TRANSCRIPCION_CON_FECHA. */
export const RESUMEN_BUENO: ResumenDelModelo = {
  que_quiere: 'Reforma integral de la vivienda',
  donde_quedo: 'Vendrá a la oficina el viernes a las seis',
  que_lo_frena: 'Falta firmar la compra',
  para_que_llamarlo: 'Confirmar la visita del viernes',
  fecha_prevista: '2026-11-20',
  fecha_prevista_cita: CITA_FECHA,
};

/** Salida del modelo para una llamada que contiene TRANSCRIPCION_BASE: presupuesto, urgencia y decisor con cita. */
export function salidaModelo(interaccionId: string, o: OpcionesSalida = {}): string {
  const p = o.presupuesto === undefined ? { min: 90000, max: 110000 } : o.presupuesto;
  return JSON.stringify({
    interaccion_id: interaccionId,
    presupuesto: p === null
      ? { detectado: false }
      : { detectado: true, tipo: 'rango', min: p.min, max: p.max, moneda: 'EUR', emisor: o.emisor ?? 'cliente', cita: FRASE.presupuesto, marca_tiempo: '00:02:10' },
    presupuesto_insuficiente_sin_solucion: o.noAptoInventado
      ? { valor: true, cita: 'No llegamos ni a la mitad de eso en ningún caso', marca_tiempo: '00:02:30' }
      : { valor: false, cita: null, marca_tiempo: null },
    criterios: {
      presupuesto: p === null ? NE : { nivel: 'A', cita: FRASE.presupuesto, marca_tiempo: '00:02:10' },
      urgencia: { plazo_meses: o.plazoMeses ?? 2, cita: FRASE.urgencia, marca_tiempo: '00:01:10' },
      decisor: { nivel: o.nivelDecisor ?? 'A', cita: o.citaDecisor ?? FRASE.decisor, marca_tiempo: '00:01:40' },
      alcance: NE, actitud: NE, encaje_lyn: NE, predisposicion_f2f3: NE,
    },
    resumen: { que_quiere: '', donde_quedo: '', que_lo_frena: '', para_que_llamarlo: '', fecha_prevista: null, fecha_prevista_cita: null, ...o.resumen },
    ...(o.decisionIA === undefined ? {} : { decision_ia: o.decisionIA }),
  });
}
