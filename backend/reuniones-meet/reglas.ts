// Reglas puras de las reuniones de Meet (869fppbcj): sin base de datos ni red, para probarlas por separado.
import type { FaseReunion } from './schema.ts';

/** Quita tildes y pasa a minúsculas para comparar texto libre. */
export function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Código de Meet (abc-defg-hij) si aparece una sola vez en el título o en el texto; si hay varios, no se supone. */
export function codigoMeet(...fuentes: Array<string | null | undefined>): string | null {
  const codigos = new Set(fuentes.flatMap((fuente) => String(fuente || '').toLowerCase().match(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/g) || []));
  return codigos.size === 1 ? [...codigos][0] : null;
}

/**
 * Fase que indica el título del evento (P-01: el título manda sobre el CRM).
 * Vale «F2», «F-3», «Fase 4» o las palabras del ticket: visita = F2, presentación = F3.
 * Si el título apunta a dos fases distintas, no se supone ninguna.
 */
export function faseDelTitulo(titulo: string | null | undefined): FaseReunion | null {
  const texto = normalizar(String(titulo || ''));
  const fases = new Set<FaseReunion>();
  for (const match of texto.matchAll(/\b(?:f|fase)\s*-?\s*([234])\b/g)) fases.add(`F${match[1]}` as FaseReunion);
  if (/\bvisita\b/.test(texto)) fases.add('F2');
  if (/\bpresentacion\b/.test(texto)) fases.add('F3');
  return fases.size === 1 ? [...fases][0] : null;
}

// Frases con las que un participante niega la grabación. Mismo criterio que las llamadas (869fpj8dm):
// ante la negativa, la reunión no se evalúa nunca, ni en una reevaluación.
const NEGATIVAS_GRABACION = [
  /\bno (?:quiero|queremos|deseo) que (?:se )?(?:me |nos |lo |la )?grab/,
  /\bprefiero que no (?:se )?(?:me |nos |lo |la )?grab/,
  /\bpreferimos que no (?:se )?(?:me |nos |lo |la )?grab/,
  /\bno (?:me |nos )?grab(?:es|eis|e usted|en)\b/,
  /\bno (?:autorizo|autorizamos|acepto|aceptamos|consiento|consentimos)(?: que se grabe| la grabacion| grabar| a que se grabe)/,
  /\bno (?:doy|damos) (?:permiso|consentimiento) (?:para|a) (?:que se )?grab/,
  /\bsin grabar,? por favor\b/,
  /\bapaga(?:d|r)? la grabacion\b/,
];

/** true si en la transcripción alguien se niega a que se grabe. Detectarlo de más es preferible a evaluar sin permiso. */
export function niegaGrabacion(transcripcion: string | null | undefined): boolean {
  const texto = normalizar(String(transcripcion || '')).replace(/\s+/g, ' ');
  return NEGATIVAS_GRABACION.some((patron) => patron.test(texto));
}

/**
 * Duración aproximada: la mayor marca de tiempo (hh:mm:ss o mm:ss) que aparece en la transcripción.
 * Meet escribe marcas periódicas, así que es una cota inferior. Sin marcas: null.
 */
export function duracionAproximada(transcripcion: string | null | undefined): number | null {
  let maximo: number | null = null;
  for (const match of String(transcripcion || '').matchAll(/(?<![\d:])(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?![\d:])/g)) {
    const segundos = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (maximo === null || segundos > maximo) maximo = segundos;
  }
  return maximo;
}
