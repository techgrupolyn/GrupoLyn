import { nivelUrgencia } from './agregacion.ts';
import { CRITERIOS_IDS, LIMITES_IMPORTE, MIN_PALABRAS_CITA, NIVELES, type CriterioId, type NivelONE } from './matriz.ts';
import { TIPOS_PRESUPUESTO, type TipoPresupuesto } from './tipos.ts';

// Contrato de salida del modelo de N-1.2 (JSON estricto) y su verificación en código: el modelo
// PROPONE niveles con su cita; el código comprueba que la cita está en la transcripción y, si no,
// el nivel pasa a NE. El modelo nunca devuelve la categoría global.

export class SalidaInvalida extends Error {}

export interface CriterioSalida {
  nivel: NivelONE;
  /** Solo Urgencia: el plazo en meses que extrajo el modelo (el nivel lo asigna el código). */
  plazoMeses: number | null;
  cita: string | null;
  marcaTiempo: string | null;
}

export interface PresupuestoSalida {
  tipo: TipoPresupuesto;
  min: number | null;
  max: number | null;
  moneda: 'EUR';
  emisor: 'cliente' | 'lyn';
  cita: string;
  marcaTiempo: string;
}

export interface NoAptoSalida {
  valor: boolean;
  cita: string | null;
  marcaTiempo: string | null;
}

export interface ResumenSalida {
  queQuiere: string;
  dondeQuedo: string;
  queLoFrena: string;
  paraQueLlamarlo: string;
  fechaPrevista: string | null;
}

export interface SalidaModelo {
  interaccionId: string;
  presupuesto: PresupuestoSalida | null;
  noApto: NoAptoSalida;
  criterios: Record<CriterioId, CriterioSalida>;
  resumen: ResumenSalida;
}

// ---------------------------------------------------------------------------------------------
// Validación del esquema
// ---------------------------------------------------------------------------------------------

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textoNoVacio = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const textoONull = (v: unknown): string | null => (textoNoVacio(v) ? v.trim() : null);
const numeroFinito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const enteroSeguro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function leerCriterio(id: CriterioId, bruto: unknown): CriterioSalida {
  if (!esObjeto(bruto)) throw new SalidaInvalida(`criterios.${id}: falta el criterio`);
  const cita = textoONull(bruto.cita);
  const marcaTiempo = textoONull(bruto.marca_tiempo);

  if (id === 'urgencia') {
    const plazo = bruto.plazo_meses;
    if (plazo === null || plazo === undefined) {
      if (cita !== null) throw new SalidaInvalida('criterios.urgencia: sin plazo la cita debe ser null');
      return { nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null };
    }
    if (!numeroFinito(plazo) || plazo < 0) throw new SalidaInvalida('criterios.urgencia: plazo_meses no es un número válido');
    if (cita === null || marcaTiempo === null) throw new SalidaInvalida('criterios.urgencia: un plazo exige cita y marca_tiempo');
    return { nivel: nivelUrgencia(plazo), plazoMeses: plazo, cita, marcaTiempo };
  }

  const nivel = bruto.nivel;
  if (nivel === 'NE') {
    if (cita !== null) throw new SalidaInvalida(`criterios.${id}: NE exige cita null`);
    return { nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null };
  }
  if (typeof nivel !== 'string' || !(NIVELES as readonly string[]).includes(nivel)) {
    throw new SalidaInvalida(`criterios.${id}: nivel desconocido`);
  }
  if (cita === null || marcaTiempo === null) throw new SalidaInvalida(`criterios.${id}: un nivel distinto de NE exige cita y marca_tiempo`);
  return { nivel: nivel as NivelONE, plazoMeses: null, cita, marcaTiempo };
}

function leerPresupuesto(bruto: unknown): PresupuestoSalida | null {
  if (!esObjeto(bruto)) throw new SalidaInvalida('presupuesto: falta el objeto');
  if (typeof bruto.detectado !== 'boolean') throw new SalidaInvalida('presupuesto.detectado debe ser verdadero o falso');
  if (!bruto.detectado) return null;

  const tipo = bruto.tipo;
  if (typeof tipo !== 'string' || !(TIPOS_PRESUPUESTO as readonly string[]).includes(tipo)) {
    throw new SalidaInvalida('presupuesto.tipo desconocido');
  }
  const min = bruto.min === null || bruto.min === undefined ? null : bruto.min;
  const max = bruto.max === null || bruto.max === undefined ? null : bruto.max;
  // Euros enteros: la base guarda los importes sin decimales y lo validado debe ser lo que se persiste.
  if ((min !== null && !enteroSeguro(min)) || (max !== null && !enteroSeguro(max))) {
    throw new SalidaInvalida('presupuesto: min y max deben ser euros enteros');
  }
  const necesitaMin = tipo === 'exacto' || tipo === 'rango' || tipo === 'abierto_superior';
  const necesitaMax = tipo === 'rango' || tipo === 'abierto_inferior';
  if ((necesitaMin && min === null) || (necesitaMax && max === null)) {
    throw new SalidaInvalida(`presupuesto: el tipo ${tipo} no trae los importes que necesita`);
  }
  if (min !== null && max !== null && min > max) throw new SalidaInvalida('presupuesto: min no puede superar a max');
  if (tipo === 'exacto' && max !== null && max !== min) throw new SalidaInvalida('presupuesto: un importe exacto lleva min igual a max');
  if (bruto.moneda !== 'EUR') throw new SalidaInvalida('presupuesto.moneda debe ser EUR');
  if (bruto.emisor !== 'cliente' && bruto.emisor !== 'lyn') throw new SalidaInvalida('presupuesto.emisor debe ser cliente o lyn');
  const cita = textoONull(bruto.cita);
  const marcaTiempo = textoONull(bruto.marca_tiempo);
  if (cita === null || marcaTiempo === null) throw new SalidaInvalida('presupuesto: exige cita y marca_tiempo');
  return {
    tipo: tipo as TipoPresupuesto,
    min,
    max,
    moneda: 'EUR',
    emisor: bruto.emisor,
    cita,
    marcaTiempo,
  };
}

function leerNoApto(bruto: unknown): NoAptoSalida {
  if (!esObjeto(bruto)) throw new SalidaInvalida('presupuesto_insuficiente_sin_solucion: falta el objeto');
  if (typeof bruto.valor !== 'boolean') throw new SalidaInvalida('presupuesto_insuficiente_sin_solucion.valor debe ser verdadero o falso');
  // Marcarlo sin cita no invalida la salida: verificarSalida no lo aplica y lo deja para revisión manual.
  return { valor: bruto.valor, cita: textoONull(bruto.cita), marcaTiempo: textoONull(bruto.marca_tiempo) };
}

function leerResumen(bruto: unknown): ResumenSalida {
  const r = esObjeto(bruto) ? bruto : {};
  const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    queQuiere: texto(r.que_quiere),
    dondeQuedo: texto(r.donde_quedo),
    queLoFrena: texto(r.que_lo_frena),
    paraQueLlamarlo: texto(r.para_que_llamarlo),
    fechaPrevista: textoONull(r.fecha_prevista),
  };
}

/** Comprueba el contrato. Lanza SalidaInvalida (el intento cuenta como fallo del modelo y se reintenta). */
export function validarSalidaModelo(raw: string, interaccionEsperada?: string): SalidaModelo {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new SalidaInvalida('la respuesta no es JSON');
  }
  if (!esObjeto(d)) throw new SalidaInvalida('la respuesta no es un objeto');
  if (!textoNoVacio(d.interaccion_id)) throw new SalidaInvalida('falta interaccion_id');
  if (interaccionEsperada !== undefined && d.interaccion_id !== interaccionEsperada) {
    throw new SalidaInvalida('interaccion_id no coincide con la llamada evaluada');
  }
  if (!esObjeto(d.criterios)) throw new SalidaInvalida('falta criterios');
  const criterios = {} as Record<CriterioId, CriterioSalida>;
  for (const id of CRITERIOS_IDS) criterios[id] = leerCriterio(id, d.criterios[id]);
  return {
    interaccionId: d.interaccion_id.trim(),
    presupuesto: leerPresupuesto(d.presupuesto),
    noApto: leerNoApto(d.presupuesto_insuficiente_sin_solucion),
    criterios,
    resumen: leerResumen(d.resumen),
  };
}

// ---------------------------------------------------------------------------------------------
// Verificación de citas contra la transcripción
// ---------------------------------------------------------------------------------------------

/** Para comparar citas: minúsculas, sin tildes ni marcadores `[NOMBRE]`, sin puntuación y con espacios simples. */
export function normalizarCita(valor: string): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La cita aparece literalmente en la transcripción (salvo mayúsculas, tildes, puntuación y espacios) y
 * tiene al menos MIN_PALABRAS_CITA palabras. Se quitan las marcas `[hh:mm:ss] GRUPO LYN:` para que una
 * cita pueda cruzar dos turnos del mismo hablante.
 */
export function citaVerificable(cita: string | null, transcripcion: string, minPalabras: number = MIN_PALABRAS_CITA): boolean {
  if (cita === null) return false;
  const c = normalizarCita(cita);
  if (c.split(' ').filter(Boolean).length < minPalabras) return false;
  const t = normalizarCita(transcripcion.replace(/^\[[^\]]*\]\s*(GRUPO LYN|CLIENTE):\s*/gm, ''));
  return t.includes(c);
}

export interface Descarte {
  campo: string;
  motivo: string;
  cita: string | null;
}

export interface SalidaVerificada {
  interaccionId: string;
  criterios: Record<CriterioId, CriterioSalida>;
  /** Presupuesto aceptado para registrarse; null si no hay, si su cita no es verificable o si va a revisión. */
  presupuesto: PresupuestoSalida | null;
  noApto: NoAptoSalida;
  /** Presupuesto con el importe fuera de rango: no se registra solo, lo revisa una persona. */
  presupuestoParaRevision: PresupuestoSalida | null;
  revisionManual: string[];
  descartes: Descarte[];
}

const importes = (p: PresupuestoSalida): number[] => [p.min, p.max].filter((n): n is number => n !== null);

/**
 * El código decide qué vale de lo que propuso el modelo: un nivel sin cita verificable pasa a NE, un
 * presupuesto sin cita verificable se descarta, un No apto sin cita verificable no se aplica y queda en
 * revisión manual, y un importe fuera de 1.000 € a 5.000.000 € no se registra solo (revisión manual).
 */
export function verificarSalida(salida: SalidaModelo, transcripcion: string): SalidaVerificada {
  const descartes: Descarte[] = [];
  const criterios = {} as Record<CriterioId, CriterioSalida>;
  for (const id of CRITERIOS_IDS) {
    const c = salida.criterios[id];
    if (c.nivel !== 'NE' && !citaVerificable(c.cita, transcripcion)) {
      descartes.push({ campo: `criterios.${id}`, motivo: 'cita no encontrada en la transcripción', cita: c.cita });
      criterios[id] = { nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null };
    } else {
      criterios[id] = { ...c };
    }
  }

  let presupuesto = salida.presupuesto;
  let presupuestoParaRevision: PresupuestoSalida | null = null;
  const revisionManual: string[] = [];
  if (presupuesto && !citaVerificable(presupuesto.cita, transcripcion)) {
    descartes.push({ campo: 'presupuesto', motivo: 'cita no encontrada en la transcripción', cita: presupuesto.cita });
    presupuesto = null;
  }
  if (presupuesto && importes(presupuesto).some((n) => n < LIMITES_IMPORTE.min || n > LIMITES_IMPORTE.max)) {
    revisionManual.push(
      `presupuesto fuera de ${LIMITES_IMPORTE.min} a ${LIMITES_IMPORTE.max} EUR: ${importes(presupuesto).join(' – ')}`,
    );
    presupuestoParaRevision = presupuesto;
    presupuesto = null;
  }

  let noApto = salida.noApto;
  const citaNoAptoValida = citaVerificable(noApto.cita, transcripcion);
  if ((noApto.valor || noApto.cita !== null) && !citaNoAptoValida) {
    descartes.push({
      campo: 'presupuesto_insuficiente_sin_solucion',
      motivo: noApto.cita === null ? 'sin cita' : 'cita no encontrada en la transcripción',
      cita: noApto.cita,
    });
    // Señalar un No apto sin poder demostrarlo no se aplica, pero lo mira una persona.
    if (noApto.valor) revisionManual.push('presupuesto insuficiente sin solución señalado sin una cita verificable');
    noApto = { valor: false, cita: null, marcaTiempo: null };
  }

  return { interaccionId: salida.interaccionId, criterios, presupuesto, noApto, presupuestoParaRevision, revisionManual, descartes };
}
