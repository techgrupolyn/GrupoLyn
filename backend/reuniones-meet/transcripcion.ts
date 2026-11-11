// Transcripción de Meet → entrada del calificador (869fppbcj, bloque C).
//
// El calificador de llamadas (netelip/calificador) espera un turno por línea con dos voces fijas:
// `[hh:mm:ss] GRUPO LYN: …` y `[hh:mm:ss] CLIENTE: …`. Su verificación de citas y su campo `marca_tiempo`
// dependen de ese formato. Meet, en cambio, escribe el nombre real de cada persona. Aquí se traduce:
//   1. leer los turnos (documento de Meet, WEBVTT o SRT) con su minuto;
//   2. decidir quién habla por Grupo LYN y quién es cliente;
//   3. reutilizar transcripcionPorTurnos y enmascarar de Juan, pasando los nombres de los clientes.
// Funciones puras: se prueban sin base de datos ni Gemini (tests/reuniones-meet-transcripcion.test.ts).
import { enmascarar, transcripcionPorTurnos, type Segmento } from '../netelip/calificador/reglas.ts';

export type Turno = { hablante: string | null; inicio: number; texto: string };

export type TranscripcionPreparada = {
  /** Texto listo para el modelo: turnos `[hh:mm:ss] GRUPO LYN|CLIENTE: …` y datos personales enmascarados. */
  transcripcion: string;
  /** Nombres tal como salen en Meet, separados por bando (para auditoría; nunca se envían al modelo). */
  hablantesLyn: string[];
  hablantesCliente: string[];
  /** false si no se reconoció ningún hablante: el modelo recibe el texto sin voces y conviene marcar duda. */
  conHablantes: boolean;
  /** Segundos de la última marca de tiempo encontrada, o null. */
  duracionSegundos: number | null;
};

// Encabezados que Meet escribe con forma «Etiqueta: …» y que no son turnos de nadie.
const ETIQUETAS_NO_HABLANTE = new Set([
  'asistentes', 'attendees', 'participantes', 'participants', 'transcripcion', 'transcript', 'invitados', 'fecha', 'date',
  'nota', 'notas', 'note', 'notes', 'resumen', 'summary', 'http', 'https',
]);
// A partir de aquí Meet solo añade pie de página.
const FIN = /^(fin de la transcripci[oó]n|la transcripci[oó]n (ha )?finaliz|transcription ended|meeting ended after|la reuni[oó]n finaliz)/i;

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokens = (s: string) => sinTildes(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);

/** `01:02:03`, `02:03` o `00:00:05.000` / `00:00:05,000` → segundos. */
export function segundos(marca: string): number {
  const partes = marca.trim().split(/[.,]/)[0].split(':').map(Number);
  return partes.reduce((total, n) => total * 60 + n, 0);
}

const LINEA_MARCA = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*$/;
const LINEA_CUE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->/;
const VOZ_VTT = /^<v(?:\.[^\s>]*)?\s+([^>]+)>(.*?)(?:<\/v>)?\s*$/i;
const TURNO = /^\s*(?:\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+)?([^:\n]{2,60}?):\s+(.+)$/;

function esNombrePosible(nombre: string): boolean {
  const n = nombre.trim();
  if (!/^\p{L}/u.test(n) || /\d/.test(n) || /[?¿!¡.,;()"«»]/.test(n)) return false;
  const palabras = n.split(/\s+/);
  return palabras.length <= 5 && !ETIQUETAS_NO_HABLANTE.has(sinTildes(palabras[0]).toLowerCase());
}

/**
 * Lee los turnos de una transcripción de Meet. Soporta:
 * - documento de Meet: marcas `00:05:00` en su propia línea y párrafos `Nombre Apellido: texto`;
 * - WEBVTT (`<v Nombre>texto` o `Nombre: texto`) y SRT.
 * Un «Nombre:» solo cuenta como hablante si aparece al menos dos veces o es del equipo, para que una frase como
 * «Mira: …» no se convierta en una persona. Lo que va antes del primer turno (título, asistentes) se descarta.
 */
export function leerTurnos(texto: string | null, equipoLyn: string[] = []): Turno[] {
  const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const candidatos = new Map<string, number>();
  for (const linea of lineas) {
    const voz = VOZ_VTT.exec(linea.trim());
    const m = voz ? [null, null, voz[1]] : TURNO.exec(linea);
    if (m && esNombrePosible(m[2] as string)) candidatos.set((m[2] as string).trim(), (candidatos.get((m[2] as string).trim()) || 0) + 1);
  }
  const valido = (nombre: string) => (candidatos.get(nombre) || 0) >= 2 || equipoLyn.some((e) => mismaPersona(nombre, e));
  const hayHablantes = [...candidatos.keys()].some(valido) || lineas.some((l) => VOZ_VTT.test(l.trim()));

  const turnos: Turno[] = [];
  let tiempo = 0;
  for (const bruta of lineas) {
    const linea = bruta.trim();
    if (!linea || /^WEBVTT/i.test(linea) || /^NOTE\b/.test(linea) || /^\d+$/.test(linea)) continue;
    if (FIN.test(sinTildes(linea))) break;
    const marca = LINEA_MARCA.exec(linea) || LINEA_CUE.exec(linea);
    if (marca) { tiempo = segundos(marca[1]); continue; }

    const voz = VOZ_VTT.exec(linea);
    const turno = voz ? null : TURNO.exec(linea);
    const nombre = (voz?.[1] ?? turno?.[2] ?? '').trim();
    // La etiqueta <v> de VTT ya dice quién habla; un «Nombre:» de texto necesita la comprobación de arriba.
    if (nombre && (voz || valido(nombre))) {
      if (turno?.[1]) tiempo = segundos(turno[1]);
      const dicho = (voz ? voz[2] : turno![3]).replace(/<[^>]+>/g, '').trim();
      if (dicho) turnos.push({ hablante: nombre, inicio: tiempo, texto: dicho });
      continue;
    }
    // Línea sin hablante. Con hablantes: continúa el turno anterior (Meet parte los párrafos largos y mete marcas
    // de tiempo en medio) y, antes del primer turno, es cabecera (título, asistentes) y se descarta.
    // Sin hablantes en todo el archivo (VTT/SRT sin voces): un turno sin voz por cada marca de tiempo.
    const limpio = linea.replace(/<[^>]+>/g, '').trim();
    const previo = turnos[turnos.length - 1];
    if (hayHablantes) {
      if (previo) previo.texto = `${previo.texto} ${limpio}`;
    } else if (previo && previo.inicio === tiempo) previo.texto = `${previo.texto} ${limpio}`;
    else turnos.push({ hablante: null, inicio: tiempo, texto: limpio });
  }
  return turnos;
}

/**
 * ¿El nombre que muestra Meet corresponde a esta persona del equipo? Meet usa el nombre de la cuenta de Google
 * («Ernesto García López»), y en `empleados` puede estar más corto («Ernesto García») o al revés.
 * Coinciden si las palabras de uno están todas en el otro.
 */
export function mismaPersona(enMeet: string, delEquipo: string): boolean {
  const a = tokens(enMeet);
  const b = tokens(delEquipo);
  if (!a.length || !b.length) return false;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.every((t) => largo.includes(t));
}

/**
 * Prepara la transcripción de una reunión de Meet para el calificador.
 * `equipoLyn`: nombres (y, si se quiere, emails) de los empleados activos; quien coincide habla por GRUPO LYN.
 * Si Ernesto acompaña al closer nuevo, los dos salen como GRUPO LYN; a quién se evalúa lo decide el organizador
 * (pregunta P-03 del ticket, pendiente de Alex).
 */
export function prepararTranscripcion(texto: string | null, equipoLyn: string[]): TranscripcionPreparada {
  const equipo = equipoLyn.map((e) => String(e || '').split('@')[0].replace(/[._]/g, ' ')).filter((e) => e.trim());
  const turnos = leerTurnos(texto, equipo);
  const conHablantes = turnos.some((t) => t.hablante);
  const lyn = new Set<string>();
  const clientes = new Set<string>();
  for (const t of turnos) {
    if (!t.hablante) continue;
    (equipo.some((e) => mismaPersona(t.hablante!, e)) ? lyn : clientes).add(t.hablante);
  }
  const segmentos: Segmento[] = turnos.map((t) => ({
    speaker: !t.hablante ? null : lyn.has(t.hablante) ? 'agente' : 'cliente',
    start: t.inicio, end: t.inicio, text: t.texto,
  }));
  // Sin turnos reconocibles, el texto tal cual (como hace Juan con una llamada sin segmentos).
  const turnosTexto = segmentos.length ? transcripcionPorTurnos(segmentos, '') : String(texto || '').trim();
  const ultimo = turnos.length ? Math.max(...turnos.map((t) => t.inicio)) : 0;
  return {
    transcripcion: enmascarar(turnosTexto, [...clientes]),
    hablantesLyn: [...lyn],
    hablantesCliente: [...clientes],
    conHablantes,
    duracionSegundos: ultimo > 0 ? ultimo : null,
  };
}
