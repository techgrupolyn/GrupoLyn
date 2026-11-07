// Reglas del calificador que deciden en código, no en el modelo: transcripción para el modelo,
// enmascarado, validación de la salida, verificación de citas, apto/escalado y texto del feedback.
// Funciones puras: se prueban sin base de datos ni Gemini (backend/tests/calificador.test.ts).
import { containsUnmaskedPersonalData, maskProtocolQuestion } from '../../protocol-privacy.ts';

export const NOTA_APTO = 80;
export const DURACION_MINIMA_SEGUNDOS = 60;
export const FEEDBACK_MAX_LINEAS = 5;
export const FEEDBACK_MAX_CARACTERES = 600;

export const REGLAS_CRITICAS = ['REGLA_CERO', 'LIMITE_PROFESIONAL', 'NO_PREGUNTAR', 'PRECIO_CERRADO_PRIMERA_REUNION', 'PRECIO_M2_TARIFA', 'ALTERAR_PROCESO'] as const;
export type ReglaCritica = typeof REGLAS_CRITICAS[number];
export const TIPOS_OBJECION = ['precio', 'plazo', 'confianza', 'decisor', 'otra'] as const;
export type TipoObjecion = typeof TIPOS_OBJECION[number];

export const NOMBRE_REGLA: Record<ReglaCritica, string> = {
  REGLA_CERO: 'REGLA CERO', LIMITE_PROFESIONAL: 'LÍMITE PROFESIONAL', NO_PREGUNTAR: 'NO PREGUNTAR',
  PRECIO_CERRADO_PRIMERA_REUNION: 'precio cerrado tras la primera reunión', PRECIO_M2_TARIFA: 'precio por m² como tarifa', ALTERAR_PROCESO: 'alterar el proceso',
};

export type Segmento = { speaker: string | null; start: number; end: number; text: string };
export type ErrorCritico = { regla: ReglaCritica; cita: string; marca_tiempo: string };
export type Objecion = { tipo: TipoObjecion; cita: string; idea_contenido: string | null };
export type SalidaModelo = {
  llamada_evaluable: boolean;
  motivo_no_evaluable: string | null;
  nota: number;
  errores_criticos: ErrorCritico[];
  bien: [string, string];
  mejorar: [{ que: string; accion: string }, { que: string; accion: string }];
  duda: { valor: boolean; motivo: string | null };
  objeciones: Objecion[];
};

export class SalidaInvalida extends Error {}

// --- Transcripción para el modelo -------------------------------------------------------------

export function marcaTiempo(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

const HABLANTE: Record<string, string> = { agente: 'GRUPO LYN', agent: 'GRUPO LYN', cliente: 'CLIENTE', customer: 'CLIENTE' };

/** Un turno por línea: `[hh:mm:ss] GRUPO LYN: …`. Sin segmentos, el texto tal cual. */
export function transcripcionPorTurnos(segments: Segmento[] | null, text: string): string {
  if (!segments?.length) return String(text || '').trim();
  return segments.filter((s) => String(s.text || '').trim()).map((s) => {
    const who = HABLANTE[String(s.speaker || '').toLowerCase()];
    return `[${marcaTiempo(s.start)}] ${who ? `${who}: ` : ''}${String(s.text).trim()}`;
  }).join('\n');
}

/** Datos del cliente sustituidos por marcadores antes de salir hacia el modelo. */
export function enmascarar(transcripcion: string, nombresCliente: string[]): string {
  // Nombre y apellidos sueltos también: Whisper suele transcribir solo uno de los dos.
  const partes = nombresCliente.flatMap((n) => [n, ...String(n || '').split(/\s+/)]).map((n) => String(n || '').trim()).filter((n) => n.length >= 4);
  return maskProtocolQuestion(transcripcion, { clientNames: partes });
}

// --- Validación de la salida del modelo -------------------------------------------------------

const texto = (v: unknown, campo: string, max = 400): string => {
  if (typeof v !== 'string' || !v.trim()) throw new SalidaInvalida(`${campo}: texto vacío`);
  return v.trim().slice(0, max);
};
const textoONull = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Comprueba el esquema estricto. Lanza SalidaInvalida (el intento cuenta como fallo del modelo). */
export function validarSalida(raw: string): SalidaModelo {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw); } catch { throw new SalidaInvalida('la respuesta no es JSON'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new SalidaInvalida('la respuesta no es un objeto');
  const evaluable = d.llamada_evaluable !== false;
  const nota = Number(d.nota);
  if (!Number.isInteger(nota) || nota < 0 || nota > 100) throw new SalidaInvalida('nota fuera de 0-100');
  const errores = Array.isArray(d.errores_criticos) ? d.errores_criticos : null;
  if (!errores) throw new SalidaInvalida('errores_criticos no es una lista');
  const bien = Array.isArray(d.bien) ? d.bien : [];
  const mejorar = Array.isArray(d.mejorar) ? d.mejorar : [];
  if (evaluable && (bien.length !== 2 || mejorar.length !== 2)) throw new SalidaInvalida('bien y mejorar deben tener 2 elementos');
  const duda = (d.duda && typeof d.duda === 'object' ? d.duda : {}) as Record<string, unknown>;
  return {
    llamada_evaluable: evaluable,
    motivo_no_evaluable: evaluable ? null : textoONull(d.motivo_no_evaluable, 200) || 'llamada no comercial',
    nota,
    errores_criticos: errores.map((e, i) => {
      const r = (e || {}) as Record<string, unknown>;
      if (!REGLAS_CRITICAS.includes(r.regla as ReglaCritica)) throw new SalidaInvalida(`errores_criticos[${i}].regla desconocida`);
      return { regla: r.regla as ReglaCritica, cita: texto(r.cita, `errores_criticos[${i}].cita`), marca_tiempo: textoONull(r.marca_tiempo, 12) || '' };
    }),
    bien: evaluable ? [texto(bien[0], 'bien[0]', 160), texto(bien[1], 'bien[1]', 160)] : ['—', '—'],
    mejorar: (evaluable ? [0, 1].map((i) => {
      const m = (mejorar[i] || {}) as Record<string, unknown>;
      return { que: texto(m.que, `mejorar[${i}].que`, 160), accion: texto(m.accion, `mejorar[${i}].accion`, 200) };
    }) : [{ que: '—', accion: '—' }, { que: '—', accion: '—' }]) as SalidaModelo['mejorar'],
    duda: { valor: duda.valor === true, motivo: duda.valor === true ? textoONull(duda.motivo, 240) || 'evidencia insuficiente' : null },
    objeciones: (Array.isArray(d.objeciones) ? d.objeciones : []).flatMap((o) => {
      const r = (o || {}) as Record<string, unknown>;
      const tipo = TIPOS_OBJECION.includes(r.tipo as TipoObjecion) ? r.tipo as TipoObjecion : 'otra';
      const cita = textoONull(r.cita, 400);
      return cita ? [{ tipo, cita, idea_contenido: textoONull(r.idea_contenido, 300) }] : [];
    }),
  };
}

// --- Verificación de citas --------------------------------------------------------------------

/** Para comparar citas: minúsculas, sin tildes ni puntuación y con espacios simples. */
export function normalizarCita(value: string): string {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** La cita aparece literalmente en la transcripción (salvo puntuación, mayúsculas y tildes), con 4 palabras o más. */
export function citaVerificable(cita: string, transcripcion: string): boolean {
  const c = normalizarCita(cita);
  if (c.split(' ').filter(Boolean).length < 4) return false;
  // Sin las marcas `[hh:mm:ss] GRUPO LYN:` para que una cita pueda cruzar dos turnos del mismo hablante.
  const t = normalizarCita(transcripcion.replace(/^\[[^\]]*\]\s*(GRUPO LYN|CLIENTE):\s*/gm, ''));
  return t.includes(c);
}

// --- Decisión ---------------------------------------------------------------------------------

export type Contexto = { presupuestoRegistrado: boolean; supervisor: string };
export type Decision = {
  errores_criticos: ErrorCritico[];
  errores_descartados: Array<ErrorCritico & { motivo: string }>;
  apto: boolean;
  escalado: boolean;
  motivo_escalado: string | null;
  duda: boolean;
  motivo_duda: string | null;
  objeciones: Objecion[];
};

/**
 * El código, no el modelo, decide qué errores valen, si es apto y si se escala:
 * - un error crítico sin cita verificable se descarta y la llamada queda con duda;
 * - NO PREGUNTAR solo es error si el presupuesto del lead está registrado (Alex, 02/11/2026);
 * - apto = nota ≥ 80 y ningún error crítico;
 * - escalado = algún error crítico, nota < 80 o duda (criterio P-01 del ticket).
 */
export function decidir(salida: SalidaModelo, transcripcion: string, ctx: Contexto): Decision {
  const validos: ErrorCritico[] = [];
  const descartados: Decision['errores_descartados'] = [];
  for (const e of salida.errores_criticos) {
    if (e.regla === 'NO_PREGUNTAR' && !ctx.presupuestoRegistrado) descartados.push({ ...e, motivo: 'presupuesto no registrado: preguntarlo no es error' });
    else if (!citaVerificable(e.cita, transcripcion)) descartados.push({ ...e, motivo: 'cita no encontrada en la transcripción' });
    else validos.push(e);
  }
  const sinCita = descartados.some((e) => e.motivo.startsWith('cita no encontrada'));
  const duda = salida.duda.valor || sinCita;
  const motivoDuda = salida.duda.valor ? salida.duda.motivo : sinCita ? 'el agente señaló un error crítico sin una cita verificable' : null;
  const apto = salida.nota >= NOTA_APTO && validos.length === 0;
  const motivos = [
    validos.length ? `error crítico: ${[...new Set(validos.map((e) => NOMBRE_REGLA[e.regla]))].join(', ')}` : null,
    salida.nota < NOTA_APTO ? `nota inferior a ${NOTA_APTO}` : null,
    duda ? `duda: ${motivoDuda}` : null,
  ].filter(Boolean) as string[];
  // Objeciones: la cita debe estar en la transcripción y no llevar datos personales sin enmascarar.
  const objeciones = salida.objeciones.filter((o) => citaVerificable(o.cita, transcripcion) && !containsUnmaskedPersonalData(o.cita)
    && !(o.idea_contenido && (containsUnmaskedPersonalData(o.idea_contenido) || /\[(NOMBRE|TEL[ÉE]FONO|EMAIL|DIRECCI[ÓO]N|DNI|IBAN)\]/i.test(o.idea_contenido))));
  return { errores_criticos: validos, errores_descartados: descartados, apto, escalado: motivos.length > 0, motivo_escalado: motivos.length ? motivos.join('; ') : null, duda, motivo_duda: motivoDuda, objeciones };
}

// --- Feedback al comercial --------------------------------------------------------------------

/** Recorta en un límite de palabra, nunca a mitad de palabra. */
const recortar = (s: string, max: number) => {
  if (s.length <= max) return s;
  const corte = s.slice(0, Math.max(0, max - 1));
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > max * 0.6 ? corte.slice(0, espacio) : corte).replace(/[\s,;:·.-]+$/u, '')}…`;
};

/** Reparte `total` caracteres entre las líneas: las cortas no gastan su parte y la ceden a las largas. */
function repartir(lineas: string[], total: number): number[] {
  const cupo = lineas.map(() => 0);
  let pendientes = lineas.map((_, i) => i);
  let restante = total;
  while (pendientes.length) {
    const parte = Math.floor(restante / pendientes.length);
    const caben = pendientes.filter((i) => lineas[i].length <= parte);
    if (!caben.length) { pendientes.forEach((i) => { cupo[i] = parte; }); break; }
    caben.forEach((i) => { cupo[i] = lineas[i].length; restante -= lineas[i].length; });
    pendientes = pendientes.filter((i) => !caben.includes(i));
  }
  return cupo;
}

/**
 * Máximo 5 líneas y 600 caracteres (Alex: «cortos, prácticos, que si no nadie lo lee»).
 * Sin datos del cliente: solo fecha, duración, nota y frases del modelo ya enmascaradas.
 */
export function textoFeedback(args: { cuando: string; duracionSegundos: number; nota: number; apto: boolean; bien: string[]; mejorar: Array<{ que: string; accion: string }>; escalado: boolean; motivoEscalado: string | null; supervisor: string }): string {
  const min = Math.max(1, Math.round(args.duracionSegundos / 60));
  const cabecera = `Llamada ${args.cuando} (${min} min): ${args.nota}/100 · ${args.apto ? 'APTO' : 'NO APTO'}`;
  const escalado = args.escalado ? `⚠️ Escalado a ${args.supervisor}: ${args.motivoEscalado || 'revisión'}` : null;
  // El presupuesto que queda se reparte entre las líneas de contenido, recortando primero lo más largo.
  const fijas = [cabecera, escalado].filter(Boolean) as string[];
  const cuerpo = [
    `✅ ${args.bien.filter(Boolean).join(' · ')}`,
    ...args.mejorar.slice(0, 2).map((m) => `➡️ ${m.que}: ${m.accion}`),
  ];
  const separadores = fijas.length + cuerpo.length - 1;
  let disponible = FEEDBACK_MAX_CARACTERES - fijas.reduce((n, l) => n + l.length, 0) - separadores;
  if (escalado && disponible < 120) {
    fijas[1] = recortar(escalado, Math.max(40, escalado.length - (120 - disponible)));
    disponible = FEEDBACK_MAX_CARACTERES - fijas.reduce((n, l) => n + l.length, 0) - separadores;
  }
  const cupo = repartir(cuerpo, disponible);
  const lineas = [fijas[0], ...cuerpo.map((l, i) => recortar(l, cupo[i])), ...(fijas[1] ? [fijas[1]] : [])];
  return lineas.slice(0, FEEDBACK_MAX_LINEAS).join('\n');
}
