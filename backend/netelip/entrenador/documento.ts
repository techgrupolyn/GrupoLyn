// Documento del entrenador de llamadas (ticket 869e9y98n): el «Contexto unificado» de Jean Parra que los
// comerciales cargan en ChatGPT para simular llamadas. Aquí solo hay funciones puras: validar lo que
// propone el modelo y añadirlo al documento. El código decide dónde va cada cosa y nunca borra texto.
import { containsUnmaskedPersonalData, maskProtocolQuestion } from '../../protocol-privacy.ts';
import { normalizarCita } from '../calificador/reglas.ts';

export const ARQUETIPOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type Arquetipo = typeof ARQUETIPOS[number];

/** Secciones del documento que se amplían con llamadas reales (número → título en el documento). */
export const SECCIONES = { arquetipos: 6, objeciones: 11, frases: 18 } as const;

export const MAX_OBJECIONES = 8;
export const MAX_ARQUETIPOS = 7;
export const MAX_FRASES = 5;

export type ObjecionNueva = { objecion: string; criterio: string; cita: string | null };
export type MaterialArquetipo = { arquetipo: Arquetipo; material: string };
export type FraseNueva = { situacion: string; frase: string };
export type Propuesta = { resumen: string; objeciones: ObjecionNueva[]; arquetipos: MaterialArquetipo[]; frases: FraseNueva[] };

export class PropuestaInvalida extends Error {}

const SEPARADOR = /^={10,}\s*$/;
const LINEA_ACTUALIZADO = /^Actualizado con llamadas reales de Netelip hasta .*$/m;

// Lo que propone el modelo sale de citas ya enmascaradas, pero se vuelve a enmascarar por si acaso.
// Si aun así queda un dato personal, la entrada se descarta.
function limpio(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = maskProtocolQuestion(value.replace(/\s+/g, ' ').trim()).slice(0, max);
  return text && !containsUnmaskedPersonalData(text) ? text : null;
}

/**
 * Comprueba la propuesta del modelo. Las entradas incompletas se descartan sin invalidar el resto;
 * una cita que no aparece en las llamadas del periodo se quita (la entrada se queda).
 */
export function validarPropuesta(raw: string, citasPeriodo: string[]): Propuesta {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { throw new PropuestaInvalida('la respuesta del modelo no es JSON'); }
  if (!data || typeof data !== 'object') throw new PropuestaInvalida('la respuesta del modelo no es un objeto');
  const lista = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')) : []);
  const fuentes = citasPeriodo.map(normalizarCita);
  const citaReal = (cita: string | null) => (cita && fuentes.some((f) => f.includes(normalizarCita(cita))) ? cita : null);

  const objeciones = lista(data.objeciones).flatMap((o) => {
    const objecion = limpio(o.objecion, 160);
    const criterio = limpio(o.criterio, 600);
    return objecion && criterio ? [{ objecion, criterio, cita: citaReal(limpio(o.cita, 300)) }] : [];
  }).slice(0, MAX_OBJECIONES);
  const arquetipos = lista(data.arquetipos).flatMap((a) => {
    const material = limpio(a.material, 600);
    const arquetipo = String(a.arquetipo || '').trim().toUpperCase() as Arquetipo;
    return material && ARQUETIPOS.includes(arquetipo) ? [{ arquetipo, material }] : [];
  }).slice(0, MAX_ARQUETIPOS);
  const frases = lista(data.frases).flatMap((f) => {
    const situacion = limpio(f.situacion, 80);
    const frase = limpio(f.frase, 400);
    return situacion && frase ? [{ situacion, frase }] : [];
  }).slice(0, MAX_FRASES);
  const resumen = limpio(data.resumen, 600) || '';
  return { resumen, objeciones, arquetipos, frases };
}

export const propuestaVacia = (p: Propuesta) => !p.objeciones.length && !p.arquetipos.length && !p.frases.length;

/** Línea de índice (posición del título) de cada sección numerada: «=====», «N. TÍTULO», «=====». */
function titulosDeSeccion(lineas: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < lineas.length - 1; i += 1) {
    const m = /^(\d+)\.\s+\S/.exec(lineas[i]);
    if (m && SEPARADOR.test(lineas[i - 1]) && SEPARADOR.test(lineas[i + 1])) out.set(Number(m[1]), i);
  }
  return out;
}

/** Inserta `bloque` al final de la sección `numero` (antes del separador de la siguiente o del cierre). */
function anadirASeccion(lineas: string[], numero: number, bloque: string[]): string[] {
  const titulos = titulosDeSeccion(lineas);
  const inicio = titulos.get(numero);
  if (inicio === undefined) throw new PropuestaInvalida(`el documento no tiene la sección ${numero}`);
  let fin = lineas.length;
  for (let i = inicio + 2; i < lineas.length; i += 1) {
    if (SEPARADOR.test(lineas[i]) || /^FIN DEL CONTEXTO UNIFICADO/.test(lineas[i])) { fin = i; break; }
  }
  while (fin > inicio + 2 && !lineas[fin - 1].trim()) fin -= 1;
  const resto = lineas.slice(fin);
  return [...lineas.slice(0, fin), '', ...bloque, ...(resto.length && resto[0].trim() ? [''] : []), ...resto];
}

const fecha = (d: Date) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' });

/**
 * Añade la propuesta al documento en las secciones 6, 11 y 18, cada bloque con la fecha y el periodo de
 * llamadas, y actualiza la línea «Actualizado con llamadas reales…» de la cabecera. No borra nada.
 */
export function aplicarPropuesta(documento: string, propuesta: Propuesta, periodo: { desde: Date | null; hasta: Date; llamadas: number }): string {
  const origen = periodo.desde ? `llamadas del ${fecha(periodo.desde)} al ${fecha(periodo.hasta)}` : `llamadas hasta el ${fecha(periodo.hasta)}`;
  const titulo = (que: string) => `${que} — CASOS REALES DE NETELIP (${origen}, ${periodo.llamadas} evaluadas)`;
  let lineas = documento.replace(/\r\n/g, '\n').split('\n');

  if (propuesta.arquetipos.length) {
    const porArquetipo = ARQUETIPOS.flatMap((a) => {
      const items = propuesta.arquetipos.filter((m) => m.arquetipo === a);
      return items.length ? [`${a} — material real:`, ...items.map((m) => `- ${m.material}`)] : [];
    });
    lineas = anadirASeccion(lineas, SECCIONES.arquetipos, [titulo('ARQUETIPOS'), 'Úsalo para dar realismo al cliente del arquetipo indicado; no sustituye su descripción.', ...porArquetipo]);
  }
  if (propuesta.objeciones.length) {
    lineas = anadirASeccion(lineas, SECCIONES.objeciones, [titulo('OBJECIONES'), ...propuesta.objeciones.flatMap((o) => [
      '', `“${o.objecion.replace(/^[“"«]|[”"»]$/g, '').toUpperCase()}”`,
      ...(o.cita ? [`Dicho por un cliente real: «${o.cita}»`] : []),
      `Criterio correcto: ${o.criterio}`,
    ])]);
  }
  if (propuesta.frases.length) {
    lineas = anadirASeccion(lineas, SECCIONES.frases, [titulo('FRASES'), ...propuesta.frases.flatMap((f) => ['', f.situacion.toUpperCase(), `“${f.frase.replace(/^[“"«]|[”"»]$/g, '')}”`])]);
  }

  let texto = lineas.join('\n');
  const marca = `Actualizado con llamadas reales de Netelip hasta el ${fecha(periodo.hasta)}`;
  if (LINEA_ACTUALIZADO.test(texto)) texto = texto.replace(LINEA_ACTUALIZADO, marca);
  else {
    // Debajo de las tres líneas de cabecera (título, subtítulo y «Versión consolidada…»).
    const cabecera = texto.split('\n');
    const pos = Math.min(3, cabecera.length);
    texto = [...cabecera.slice(0, pos), marca, ...cabecera.slice(pos)].join('\n');
  }
  return texto;
}

/** Bloques del documento para el .docx: títulos de sección, separadores y párrafos. */
export type Bloque = { tipo: 'titulo' | 'seccion' | 'subtitulo' | 'parrafo' | 'vineta' | 'tabla'; texto: string };

export function bloquesDelDocumento(documento: string): Bloque[] {
  const lineas = documento.replace(/\r\n/g, '\n').split('\n');
  const titulos = new Set(titulosDeSeccion(lineas).values());
  const bloques: Bloque[] = [];
  lineas.forEach((linea, i) => {
    if (SEPARADOR.test(linea) || !linea.trim()) return;
    if (i < 2) bloques.push({ tipo: 'titulo', texto: linea.trim() });
    else if (titulos.has(i)) bloques.push({ tipo: 'seccion', texto: linea.trim() });
    else if (/— CASOS REALES DE NETELIP \(/.test(linea)) bloques.push({ tipo: 'subtitulo', texto: linea.trim() });
    else if (/^\s*[-•]\s+/.test(linea)) bloques.push({ tipo: 'vineta', texto: linea.replace(/^\s*[-•]\s+/, '') });
    else if (/^\|/.test(linea)) bloques.push({ tipo: 'tabla', texto: linea });
    else bloques.push({ tipo: 'parrafo', texto: linea });
  });
  return bloques;
}
