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

export const NOMBRE_REGLA: Record<string, string> = {
  REGLA_CERO: 'REGLA CERO', LIMITE_PROFESIONAL: 'LÍMITE PROFESIONAL', NO_PREGUNTAR: 'NO PREGUNTAR',
  PRECIO_CERRADO_PRIMERA_REUNION: 'precio cerrado tras la primera reunión', PRECIO_M2_TARIFA: 'precio por m² como tarifa', ALTERAR_PROCESO: 'alterar el proceso',
};

export type Segmento = { speaker: string | null; start: number; end: number; text: string };
// En las rúbricas versionadas los códigos salen de la versión (p. ej. EXCEPCION_SIN_AUTORIZACION).
export type ErrorCritico = { regla: string; cita: string; marca_tiempo: string };
export type PasoPuntuado = { paso: number; nombre: string; peso: number; aplica: boolean; puntos: number; comentario: string };
/** Lo que la validación necesita de una rubrica_version (ver rubrica.ts). */
export type RubricaParaValidar = { criterios: Array<{ paso: number; nombre: string; peso: number }>; errores_criticos: Array<{ codigo: string; nombre: string }> };
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
  /** Solo con rúbrica versionada: puntos por paso. La nota sale de aquí, no del modelo. */
  pasos?: PasoPuntuado[];
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

/**
 * Datos del cliente sustituidos por marcadores antes de salir hacia el modelo: los del CRM (nombre y direcciones
 * guardadas) y, por patrón, teléfono, email, DNI, IBAN y direcciones postales (protocol-privacy).
 */
export function enmascarar(transcripcion: string, nombresCliente: string[], direccionesCliente: string[] = []): string {
  // Nombre y apellidos sueltos también: Whisper suele transcribir solo uno de los dos.
  const partes = nombresCliente.flatMap((n) => [n, ...String(n || '').split(/\s+/)]).map((n) => String(n || '').trim()).filter((n) => n.length >= 4);
  return maskProtocolQuestion(transcripcion, { clientNames: partes, clientAddresses: direccionesCliente.filter(Boolean) });
}

// --- Validación de la salida del modelo -------------------------------------------------------

const texto = (v: unknown, campo: string, max = 400): string => {
  if (typeof v !== 'string' || !v.trim()) throw new SalidaInvalida(`${campo}: texto vacío`);
  return v.trim().slice(0, max);
};
const textoONull = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Nota sobre 100 con los pesos de los pasos que aplican: un paso que no corresponde no resta. */
export function notaPorPasos(pasos: Array<{ peso: number; aplica: boolean; puntos: number }>): number {
  const aplican = pasos.filter((p) => p.aplica);
  const posible = aplican.reduce((n, p) => n + p.peso, 0);
  return posible ? Math.round(aplican.reduce((n, p) => n + p.puntos, 0) * 100 / posible) : 0;
}

function validarPasos(raw: unknown, rubrica: RubricaParaValidar, evaluable: boolean): PasoPuntuado[] {
  const lista = Array.isArray(raw) ? raw : [];
  return rubrica.criterios.map((c) => {
    const r = lista.find((x) => Number((x as Record<string, unknown>)?.paso) === c.paso) as Record<string, unknown> | undefined;
    if (!r) {
      if (evaluable) throw new SalidaInvalida(`pasos: falta el paso ${c.paso}`);
      return { paso: c.paso, nombre: c.nombre, peso: c.peso, aplica: false, puntos: 0, comentario: '—' };
    }
    const puntos = Number(r.puntos);
    if (!Number.isInteger(puntos) || puntos < 0 || puntos > c.peso) throw new SalidaInvalida(`pasos[${c.paso}].puntos fuera de 0-${c.peso}`);
    const aplica = r.aplica !== false;
    return { paso: c.paso, nombre: c.nombre, peso: c.peso, aplica, puntos: aplica ? puntos : 0, comentario: textoONull(r.comentario, 200) || '—' };
  });
}

/**
 * Comprueba el esquema estricto. Lanza SalidaInvalida (el intento cuenta como fallo del modelo).
 * Con `rubrica` (versionada), los errores válidos son los de la versión y la nota se calcula con los pasos.
 */
export function validarSalida(raw: string, rubrica?: RubricaParaValidar): SalidaModelo {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw); } catch { throw new SalidaInvalida('la respuesta no es JSON'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new SalidaInvalida('la respuesta no es un objeto');
  const evaluable = d.llamada_evaluable !== false;
  const pasos = rubrica ? validarPasos(d.pasos, rubrica, evaluable) : undefined;
  const nota = pasos ? notaPorPasos(pasos) : Number(d.nota);
  if (!Number.isInteger(nota) || nota < 0 || nota > 100) throw new SalidaInvalida('nota fuera de 0-100');
  const reglasValidas: readonly string[] = rubrica ? rubrica.errores_criticos.map((e) => e.codigo) : REGLAS_CRITICAS;
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
      if (!reglasValidas.includes(String(r.regla))) throw new SalidaInvalida(`errores_criticos[${i}].regla desconocida`);
      return { regla: String(r.regla), cita: texto(r.cita, `errores_criticos[${i}].cita`), marca_tiempo: textoONull(r.marca_tiempo, 12) || '' };
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
    ...(pasos ? { pasos } : {}),
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

export type Contexto = {
  presupuestoRegistrado: boolean; supervisor: string;
  /** Rúbrica versionada: nota mínima para APTO y nombres legibles de sus errores críticos. */
  notaApto?: number; nombresReglas?: Record<string, string>;
};
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
 * - una respuesta ambigua del comercial sobre viabilidad, plazo o precio deja duda aunque el modelo no la marque;
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
  // Red de seguridad (CAL-04): el modelo a veces da por buena una respuesta ambigua sobre viabilidad, plazo o precio.
  const ambigua = !salida.duda.valor && !sinCita && !validos.some((e) => e.regla === 'LIMITE_PROFESIONAL') ? detectarRespuestaAmbigua(transcripcion) : null;
  const duda = salida.duda.valor || sinCita || Boolean(ambigua);
  const motivoDuda = salida.duda.valor ? salida.duda.motivo : sinCita ? 'el agente señaló un error crítico sin una cita verificable'
    : ambigua ? `respuesta ambigua sobre viabilidad, plazo o precio: «${ambigua}»` : null;
  const notaApto = ctx.notaApto ?? NOTA_APTO;
  const nombre = (codigo: string) => ctx.nombresReglas?.[codigo] ?? NOMBRE_REGLA[codigo] ?? codigo;
  const apto = salida.nota >= notaApto && validos.length === 0;
  const motivos = [
    validos.length ? `error crítico: ${[...new Set(validos.map((e) => nombre(e.regla)))].join(', ')}` : null,
    salida.nota < notaApto ? `nota inferior a ${notaApto}` : null,
    duda ? `duda: ${motivoDuda}` : null,
  ].filter(Boolean) as string[];
  // Objeciones: la cita debe estar en la transcripción y no llevar datos personales sin enmascarar.
  const objeciones = salida.objeciones.filter((o) => citaVerificable(o.cita, transcripcion) && !containsUnmaskedPersonalData(o.cita)
    && !(o.idea_contenido && (containsUnmaskedPersonalData(o.idea_contenido) || /\[(NOMBRE|TEL[ÉE]FONO|EMAIL|DIRECCI[ÓO]N|DNI|IBAN)\]/i.test(o.idea_contenido))));
  return { errores_criticos: validos, errores_descartados: descartados, apto, escalado: motivos.length > 0, motivo_escalado: motivos.length ? motivos.join('; ') : null, duda, motivo_duda: motivoDuda, objeciones };
}

// --- Consentimiento de grabación (869fpj8dm) -------------------------------------------------

// Frases con las que alguien se niega a que se grabe. Se buscan en toda la transcripción (las etiquetas de
// hablante no son fiables), en minúsculas y sin tildes. «No me importa que se grabe» no es una negativa.
// Las hipótesis del comercial («si no quiere que se grabe…», «si prefieres que no…») no cuentan.
const NEGATIVAS_GRABACION = [
  /(?<!\bsi )\bno (?:quiero|quiere|queremos|deseo|me gusta|nos gusta|me gustaria|prefiero|preferimos|acepto|autorizo|consiento|doy permiso para) (?:que )?(?:se |me |la |nos |lo )?(?:grab|registr)/,
  /(?<!\bsi )\b(?:prefiero|preferimos|preferiria|mejor) que no (?:se |me |la |nos )?grab/,
  /(?<!\bsi )\bno (?:me |nos |la |lo )?(?:grabes|grabeis|graben)\b/,
  /\bsin grabar(?:la|me)? (?:por favor|gracias|mejor)/,
];
// Respuesta del guion cuando el cliente no quiere: «Sin problema, tomo las notas yo». Una oferta previa
// («si lo prefieres, tomo yo las notas») no es negativa: hace falta el «sin problema» o similar.
const RESPUESTA_GUION = /\b(?:sin problema|ningun problema|no hay problema|vale|de acuerdo|perfecto)\b.*\btomo (?:yo )?(?:las |unas )?notas\b/;
const plano = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!.,;:"«»()]/g, ' ').replace(/\s+/g, ' ');
const sinMarca = (linea: string) => linea.replace(/^\[[^\]]*\]\s*(?:GRUPO LYN|CLIENTE)?:?\s*/, '').trim().slice(0, 200);

/**
 * Devuelve la frase en la que se niega la grabación, o null. Si la hay, la llamada no se envía al modelo
 * (ni ahora ni en una reevaluación), queda «sin consentimiento» y no se guardan objeciones.
 */
export function detectarNegativaGrabacion(transcripcion: string): string | null {
  const lineas = String(transcripcion || '').split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const t = plano(lineas[i]);
    if (NEGATIVAS_GRABACION.some((re) => re.test(t))) return sinMarca(lineas[i]);
    // «Sin problema, tomo las notas yo» justo después de hablar de la grabación.
    if (RESPUESTA_GUION.test(t) && lineas.slice(Math.max(0, i - 3), i + 1).some((l) => /grab/.test(plano(l)))) return sinMarca(lineas[i]);
  }
  return null;
}

// --- Respuesta ambigua sobre viabilidad, plazo o precio (CAL-04) -----------------------------

// Fórmulas que ni prometen ni remiten a revisión. «Depende» suelto no cuenta: es lo correcto al dar una horquilla.
const RESPUESTAS_AMBIGUAS = [
  /\bno (?:deberia|tendria que|creo que) (?:haber|haya|habra|hay) (?:mucho |muchos |ningun |demasiado |gran )?problemas?\b/,
  /\ben principio (?:si\b|se puede|no (?:hay|habria|deberia|tiene por que)|podria|cabe|entra|da tiempo|llegamos|lo tenemos|seria posible)/,
  /\bya lo (?:veriamos|veremos)\b/,
  /\blo (?:veriamos|veremos) sobre la marcha\b/,
  /\bseguramente se (?:pueda|podra|puede)\b/,
];
// Tema técnico, de plazo o de precio en el turno o en los dos anteriores (la pregunta del cliente).
const TEMA_VIABILIDAD = /\b(?:muro|tabique|pared|carga|estructur\w*|viga|pilar|forjado|ventana\w*|licencia|permiso|ayuntamiento|ampli\w+|tirar|derrib\w+|abrir|terraza|cerramiento|bajante|instalaci\w+|plazo|meses|semanas|termin\w*|acab\w*|a tiempo|precio|presupuesto|euros|cuesta|costar\w*|coste)\b/;

/**
 * Devuelve la frase del comercial con una respuesta ambigua («en principio no debería haber problema», «ya lo
 * veríamos») sobre viabilidad técnica, plazo o precio, o null. `decidir` la usa para forzar la duda cuando el modelo
 * no la marcó: es una red de seguridad, no un error crítico. Los turnos etiquetados CLIENTE no cuentan
 * («¿te viene bien el jueves?» «en principio sí» no es una promesa).
 */
export function detectarRespuestaAmbigua(transcripcion: string): string | null {
  const lineas = String(transcripcion || '').split('\n');
  for (let i = 0; i < lineas.length; i++) {
    if (/^\[[^\]]*\]\s*CLIENTE:/.test(lineas[i])) continue;
    const t = plano(lineas[i]);
    if (RESPUESTAS_AMBIGUAS.some((re) => re.test(t)) && lineas.slice(Math.max(0, i - 2), i + 1).some((l) => TEMA_VIABILIDAD.test(plano(l)))) return sinMarca(lineas[i]);
  }
  return null;
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
