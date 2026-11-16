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
  /** Duración exacta del pie de Meet («La transcripción finalizó después de 00:11:26») o, si no lo hay, la última marca. */
  duracionSegundos: number | null;
};

// Encabezados que Meet escribe con forma «Etiqueta: …» y que no son turnos de nadie.
const ETIQUETAS_NO_HABLANTE = new Set([
  'asistentes', 'attendees', 'participantes', 'participants', 'transcripcion', 'transcript', 'invitados', 'fecha', 'date',
  'nota', 'notas', 'note', 'notes', 'resumen', 'summary', 'http', 'https',
]);
// A partir de aquí Meet solo añade pie de página. Formato real (11/2026, Meet en español):
//   «La transcripción finalizó después de 00:11:26» y una línea de aviso («Esta transcripción editable se generó…»).
const FIN = /^(fin de la transcripci[oó]n|la transcripci[oó]n (ha )?finaliz|transcription ended|meeting ended after|la reuni[oó]n finaliz)/i;
const DURACION_PIE = /(\d{1,2}:\d{2}:\d{2})/;

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
  // Puede llevar números: en LYN hay cuentas compartidas como «Interiorista Lyn 15». No puede empezar por número
  // ni parecer un teléfono o una cifra larga.
  if (!/^\p{L}/u.test(n) || /\d{4,}/.test(n) || /[?¿!¡.,;()"«»]/.test(n)) return false;
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
  return leerConPie(texto, equipoLyn).turnos;
}

function leerConPie(texto: string | null, equipoLyn: string[]): { turnos: Turno[]; duracionPie: number | null } {
  const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const candidatos = new Map<string, number>();
  for (const linea of lineas) {
    const voz = VOZ_VTT.exec(linea.trim());
    const m = voz ? [null, null, voz[1]] : TURNO.exec(linea);
    if (m && esNombrePosible(m[2] as string)) candidatos.set((m[2] as string).trim(), (candidatos.get((m[2] as string).trim()) || 0) + 1);
  }
  const valido = (nombre: string) => (candidatos.get(nombre) || 0) >= 2 || esCuentaLyn(nombre) || equipoLyn.some((e) => mismaPersona(nombre, e));
  const hayHablantes = [...candidatos.keys()].some(valido) || lineas.some((l) => VOZ_VTT.test(l.trim()));

  const turnos: Turno[] = [];
  let tiempo = 0;
  let duracionPie: number | null = null;
  for (const bruta of lineas) {
    const linea = bruta.trim();
    if (!linea || /^WEBVTT/i.test(linea) || /^NOTE\b/.test(linea) || /^\d+$/.test(linea)) continue;
    if (FIN.test(sinTildes(linea))) {
      const pie = DURACION_PIE.exec(linea);
      if (pie) duracionPie = segundos(pie[1]);
      break;
    }
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
  return { turnos, duracionPie };
}

/**
 * Cuentas de Google de la empresa: en LYN muchas reuniones se hacen con cuentas compartidas cuyo nombre no es el de
 * una persona («Tech Grupo LYN», «Interiorista Lyn 15»). Si el nombre lleva la palabra LYN o GrupoLyn, habla por
 * GRUPO LYN aunque no coincida con ningún empleado.
 */
export function esCuentaLyn(nombre: string): boolean {
  return tokens(nombre).some((t) => t === 'lyn' || t === 'grupolyn');
}

// Dirección en mitad de una frase: tipo de vía + nombre (hasta 6 palabras) + número, con piso o puerta opcionales.
// Desde CAL-01 el enmascarado del calificador (protocol-privacy) también tapa direcciones en mitad de la frase; esta
// regla se mantiene como segunda pasada para las reuniones, donde los turnos son largos.
// El nombre de la vía debe empezar en mayúscula (lo normal en Meet con nombres propios) para no tapar frases como
// «la plaza a las 10». Una dirección escrita toda en minúsculas no se tapa: limitación conocida.
const DIRECCION_EN_FRASE = /\b(?:[Cc]alle|[Cc]\/|[Aa]venida|[Aa]vda\.?|[Aa]v\.|[Pp]aseo|[Pp]laza|[Pp]l\.|[Cc]arretera|[Cc]tra\.?|[Cc]amino|[Rr]onda|[Uu]rbanizaci[oó]n|[Pp]artida)\s+(?:(?:de|del|la|las|los|el|d')\s+)*\p{Lu}[\p{L}'’-]*(?:\s+(?:de|del|la|las|los|el|y|\p{Lu}[\p{L}'’-]*)){0,5}\s*,?\s*(?:n[º°o.]?\s*)?\d{1,4}(?:\s?[A-Za-z](?![\p{L}]))?(?:\s*[,-]?\s*\d{1,2}\s*[º°ª]?(?:\s?[A-Za-z](?![\p{L}]))?)?/gu;

/** Tapa direcciones con número aunque no terminen la línea. Complementa a `enmascarar` del calificador. */
export function enmascararDirecciones(texto: string): string {
  return texto.replace(DIRECCION_EN_FRASE, '[DIRECCIÓN]');
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
export function prepararTranscripcion(texto: string | null, equipoLyn: string[], opciones: { nombresCliente?: string[] } = {}): TranscripcionPreparada {
  const equipo = equipoLyn.map((e) => String(e || '').split('@')[0].replace(/[._]/g, ' ')).filter((e) => e.trim());
  const { turnos, duracionPie } = leerConPie(texto, equipo);
  const conHablantes = turnos.some((t) => t.hablante);
  const lyn = new Set<string>();
  const clientes = new Set<string>();
  for (const t of turnos) {
    if (!t.hablante) continue;
    (esCuentaLyn(t.hablante) || equipo.some((e) => mismaPersona(t.hablante!, e)) ? lyn : clientes).add(t.hablante);
  }
  const segmentos: Segmento[] = turnos.map((t) => ({
    speaker: !t.hablante ? null : lyn.has(t.hablante) ? 'agente' : 'cliente',
    start: t.inicio, end: t.inicio, text: t.texto,
  }));
  // Sin turnos reconocibles, el texto tal cual (como hace Juan con una llamada sin segmentos).
  const turnosTexto = segmentos.length ? transcripcionPorTurnos(segmentos, '') : String(texto || '').trim();
  const ultimo = turnos.length ? Math.max(...turnos.map((t) => t.inicio)) : 0;
  return {
    // Se enmascaran los clientes que hablan y los que solo se mencionan pero se conocen (invitados de Calendar, lead).
    transcripcion: enmascararDirecciones(enmascarar(turnosTexto, [...clientes, ...(opciones.nombresCliente || [])])),
    hablantesLyn: [...lyn],
    hablantesCliente: [...clientes],
    conHablantes,
    duracionSegundos: duracionPie ?? (ultimo > 0 ? ultimo : null),
  };
}
