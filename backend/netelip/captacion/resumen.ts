import { citaVerificable, type ResumenSalida } from './salida-modelo.ts';

// N-1.3 · Resumen ejecutivo del lead (869fny1ek): 4 bloques, una línea cada uno, sin importes ni datos de contacto.
// El modelo los PROPONE en el mismo llamado de N-1.2; el código decide si valen. Un resumen que no cumple no se guarda
// y el anterior se mantiene: nunca se escribe en ClickUp algo que no haya pasado esta validación.

export interface ResumenLead {
  queQuiere: string;
  dondeQuedo: string;
  queLoFrena: string;
  paraQueLlamarlo: string;
  /** AAAA-MM-DD de la siguiente acción acordada con el lead; null si no hay fecha acordada. */
  fechaPrevista: string | null;
}

/** Los bloques en el orden fijo del texto de Alex, con la etiqueta que lleva cada línea en ClickUp. */
export const BLOQUES_RESUMEN = [
  { clave: 'queQuiere', etiqueta: 'Qué quiere' },
  { clave: 'dondeQuedo', etiqueta: 'Dónde quedó' },
  { clave: 'queLoFrena', etiqueta: 'Qué lo frena' },
  { clave: 'paraQueLlamarlo', etiqueta: 'Para qué llamarlo' },
] as const;

export const MAX_CARACTERES_RESUMEN = 600;
export const SIN_INFORMACION = 'Sin información';
export const SIN_FECHA_ACORDADA = 'sin fecha acordada';
export const PREGUNTAR_PRESUPUESTO = 'Preguntar presupuesto';
/** La siguiente acción acordada no puede quedar más lejos que esto de la llamada: una fecha de años después es casi seguro un error. */
export const MAX_DIAS_FECHA_PREVISTA = 400;

/** El texto que se escribe en el campo «Resumen ejecutivo»: una línea con etiqueta por bloque. */
export function renderResumen(r: ResumenLead): string {
  return BLOQUES_RESUMEN.map((b) => `${b.etiqueta}: ${r[b.clave]}`).join('\n');
}

/** AAAA-MM-DD → DD/MM/AAAA, tal como se lee en la tarjeta. */
export const fechaLegible = (iso: string): string => iso.split('-').reverse().join('/');

/** AAAA-MM-DD en hora de Madrid. */
export function fechaMadrid(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------------------------------------------------------------------------------------------
// Qué no puede llevar un bloque
// ---------------------------------------------------------------------------------------------

const PATRONES_IMPORTE: readonly RegExp[] = [
  /[€$£]/,
  /\b(?:euros?|eur)\b/i,
  /\d\s*(?:k|mil|millones?)\b/i,
  /\bmil\b|\bmill[oó]n(?:es)?\b/i,
  /\d{1,3}(?:[.,]\d{3})+/,
  /\d{5,}/,
];

/** El texto menciona una cifra de dinero («90.000», «40k», «cien mil», «500 euros», «€»). Los años y los m² no cuentan. */
export const contieneImporte = (texto: string): boolean => PATRONES_IMPORTE.some((p) => p.test(texto));

const PATRON_DIRECCION =
  /(?:\b(?:[Cc]alle|[Aa]vda?\.?|[Aa]venida|[Pp]laza|[Pp]aseo|[Cc]amino|[Cc]arrer|[Cc]arretera|[Uu]rbanizaci[oó]n)\s+|\b[Cc]\/\s*)(?:(?:de|del|la|el|los|las)\s+)*(?:[A-ZÁÉÍÓÚÑ]|\d)/;

// «calle mayor 5», «avenida de la constitución 12, 3ºB»: la palabra de la vía, hasta cuatro palabras y un número de portal (sin importar las
// mayúsculas). El número debe cerrar la dirección (fin, signo, «piso», «puerta», «bajo» o «3º»): «plaza de garaje para 2 coches» no cuenta.
const PATRON_DIRECCION_CON_NUMERO =
  /\b(?:calle|avda?\.?|avenida|plaza|paseo|camino|carrer|carretera|urbanizaci[oó]n)\s+(?:\p{L}+\s+){1,4}\d{1,3}(?=\s*(?:[,.;)]|$|piso\b|puerta\b|bajo\b|\d?[ºª]))/iu;

/** Teléfono, email, dirección postal o un marcador de enmascarado como [NOMBRE]. Las fechas ISO no cuentan como teléfono. */
export function contieneDatoDeContacto(texto: string): boolean {
  if (/\S+@\S+\.\S+/.test(texto)) return true;
  if (/\[[^\]]*\]/.test(texto)) return true;
  if (PATRON_DIRECCION.test(texto)) return true;
  if (PATRON_DIRECCION_CON_NUMERO.test(texto)) return true;
  const sinFechas = texto.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  return /(?:\d[\s.-]?){9,}/.test(sinFechas);
}

// La cita de la fecha debe hablar de una fecha o un plazo: un número, un día de la semana, un mes, «mañana», «semana»… Una frase como
// «te llamo cuando pueda» no respalda ninguna fecha aunque esté en la transcripción. Es una comprobación de indicio, no de significado.
const INDICIO_DE_FECHA =
  /\d|\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[ñn]ana|pasado|semanas?|quincena|mes|meses|d[ií]as?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|navidad|verano|pr[oó]xim[oa]s?|finales|principios|mediados)\b/i;

const esFechaReal = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

// ---------------------------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------------------------

export interface ContextoResumen {
  /** Transcripción tal como se le dio al modelo (enmascarada): contra ella se verifica la cita de la fecha. */
  transcripcion: string;
  /** Fecha de la llamada, AAAA-MM-DD (hora de Madrid): la fecha prevista no puede ser anterior. */
  fechaLlamada: string;
  /** El lead ya tiene un presupuesto vigente (de cualquier fuente). Si no, «Para qué llamarlo» lleva «Preguntar presupuesto». */
  tienePresupuesto: boolean;
}

export type ResultadoResumen =
  | { ok: true; resumen: ResumenLead }
  | { ok: false; motivo: 'vacio' | 'invalido'; detalle: string };

const unaLinea = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Añade una indicación al final del bloque sin repetirla; si el bloque no tenía información, la indicación lo sustituye. */
function anadir(bloque: string, extra: string): string {
  if (bloque === SIN_INFORMACION) return extra.charAt(0).toUpperCase() + extra.slice(1);
  return `${bloque.replace(/[\s.;,]+$/, '')}; ${extra}`;
}

/**
 * Comprueba el resumen que propuso el modelo y lo deja listo para guardar:
 * - un bloque sin texto pasa a «Sin información» (los cuatro vacíos no es un resumen);
 * - sin importes de dinero ni datos de contacto en ningún bloque;
 * - la fecha prevista es una fecha real, no anterior a la llamada ni a más de 400 días de ella, y viene con una cita literal de la transcripción;
 * - sin fecha acordada el último bloque lo dice («sin fecha acordada»), con fecha acordada la lleva escrita («fecha prevista DD/MM/AAAA»),
 *   y sin presupuesto registrado añade «Preguntar presupuesto»;
 * - el texto completo, con sus etiquetas, no pasa de 600 caracteres.
 */
export function validarResumen(r: ResumenSalida, c: ContextoResumen): ResultadoResumen {
  const brutos = { queQuiere: unaLinea(r.queQuiere), dondeQuedo: unaLinea(r.dondeQuedo), queLoFrena: unaLinea(r.queLoFrena), paraQueLlamarlo: unaLinea(r.paraQueLlamarlo) };
  if (BLOQUES_RESUMEN.every((b) => brutos[b.clave] === '')) return { ok: false, motivo: 'vacio', detalle: 'el resumen viene vacío' };

  const invalido = (detalle: string): ResultadoResumen => ({ ok: false, motivo: 'invalido', detalle });
  const bloques = { ...brutos };
  for (const b of BLOQUES_RESUMEN) {
    if (bloques[b.clave] === '') bloques[b.clave] = SIN_INFORMACION;
    if (contieneImporte(bloques[b.clave])) return invalido(`«${b.etiqueta}» menciona un importe`);
    if (contieneDatoDeContacto(bloques[b.clave])) return invalido(`«${b.etiqueta}» lleva un dato de contacto`);
  }

  const fecha = r.fechaPrevista;
  if (fecha !== null) {
    if (!esFechaReal(fecha)) return invalido('la fecha prevista no es una fecha AAAA-MM-DD válida');
    if (fecha < c.fechaLlamada) return invalido('la fecha prevista es anterior a la llamada');
    if ((Date.parse(fecha) - Date.parse(c.fechaLlamada)) / 86_400_000 > MAX_DIAS_FECHA_PREVISTA) {
      return invalido(`la fecha prevista queda a más de ${MAX_DIAS_FECHA_PREVISTA} días de la llamada`);
    }
    if (!citaVerificable(r.fechaCita, c.transcripcion)) return invalido('la fecha prevista no trae una cita verificable de la llamada');
    if (!INDICIO_DE_FECHA.test(r.fechaCita ?? '')) return invalido('la cita de la fecha prevista no menciona ninguna fecha ni plazo');
  }

  let para = bloques.paraQueLlamarlo;
  if (!c.tienePresupuesto && /\bno\b[^.;]{0,20}preguntar presupuesto/i.test(para)) return invalido('«Para qué llamarlo» dice que no se pregunte el presupuesto y el lead no tiene ninguno');
  if (!c.tienePresupuesto && !/preguntar presupuesto/i.test(para)) para = anadir(para, PREGUNTAR_PRESUPUESTO);
  if (fecha === null && !new RegExp(SIN_FECHA_ACORDADA, 'i').test(para)) para = anadir(para, SIN_FECHA_ACORDADA);
  // Con fecha acordada, la fecha viaja a la vista: «Para qué llamarlo» la lleva escrita (DD/MM/AAAA) salvo que el bloque ya la diga así.
  if (fecha !== null) {
    const escrita = fechaLegible(fecha);
    if (!para.includes(escrita) && !para.includes(fecha)) para = anadir(para, `fecha prevista ${escrita}`);
  }
  bloques.paraQueLlamarlo = para;

  const resumen: ResumenLead = { ...bloques, fechaPrevista: fecha };
  const largo = renderResumen(resumen).length;
  if (largo > MAX_CARACTERES_RESUMEN) return invalido(`el resumen tiene ${largo} caracteres (máximo ${MAX_CARACTERES_RESUMEN})`);
  return { ok: true, resumen };
}
