// Llamada a Gemini para el calificador: rúbrica versionada (rubrica-v1.md), temperatura 0 y salida
// JSON con esquema estricto. Mismo endpoint y forma de respuesta que protocol-gemini.ts.
import { readFileSync } from 'node:fs';
import { REGLAS_CRITICAS, TIPOS_OBJECION } from './reglas.ts';

export const VERSION_RUBRICA = 'fase0-v1';
const RUBRICA = readFileSync(new URL('./rubrica-v1.md', import.meta.url), 'utf8');

const SCHEMA = {
  type: 'object',
  properties: {
    llamada_evaluable: { type: 'boolean' },
    motivo_no_evaluable: { type: ['string', 'null'] },
    nota: { type: 'integer', minimum: 0, maximum: 100 },
    errores_criticos: { type: 'array', items: { type: 'object', properties: {
      regla: { type: 'string', enum: [...REGLAS_CRITICAS] }, cita: { type: 'string' }, marca_tiempo: { type: 'string' },
    }, required: ['regla', 'cita', 'marca_tiempo'] } },
    bien: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
    mejorar: { type: 'array', items: { type: 'object', properties: { que: { type: 'string' }, accion: { type: 'string' } }, required: ['que', 'accion'] }, minItems: 2, maxItems: 2 },
    duda: { type: 'object', properties: { valor: { type: 'boolean' }, motivo: { type: ['string', 'null'] } }, required: ['valor', 'motivo'] },
    objeciones: { type: 'array', items: { type: 'object', properties: {
      tipo: { type: 'string', enum: [...TIPOS_OBJECION] }, cita: { type: 'string' }, idea_contenido: { type: ['string', 'null'] },
    }, required: ['tipo', 'cita', 'idea_contenido'] } },
  },
  required: ['llamada_evaluable', 'motivo_no_evaluable', 'nota', 'errores_criticos', 'bien', 'mejorar', 'duda', 'objeciones'],
};

// Ejemplo breve de la forma esperada (few-shot): no son llamadas reales.
const EJEMPLO = `## Ejemplo de entrada y salida

Contexto: rol sdr · llamada saliente · 3 min · presupuesto_registrado: no
[00:00:04] GRUPO LYN: Hola [NOMBRE], soy Laura de Grupo LYN, te llamo por la solicitud de reforma que nos dejaste. ¿Te pillo bien?
[00:00:09] CLIENTE: Sí, dime.
[00:00:40] CLIENTE: Es un piso de 90 metros en Alicante, queremos tirar el tabique de la cocina, que es de carga creo.
[00:00:52] GRUPO LYN: Sí, eso se puede tirar sin problema, lo hacemos mucho.
[00:02:30] CLIENTE: Me da miedo que la obra se alargue meses.
[00:02:50] GRUPO LYN: Vale, pues lo hablas con tu mujer y ya me dices.

Salida:
{"llamada_evaluable":true,"motivo_no_evaluable":null,"nota":46,"errores_criticos":[{"regla":"LIMITE_PROFESIONAL","cita":"Sí, eso se puede tirar sin problema, lo hacemos mucho.","marca_tiempo":"00:00:52"},{"regla":"REGLA_CERO","cita":"pues lo hablas con tu mujer y ya me dices","marca_tiempo":"00:02:50"}],"bien":["Apertura clara: te presentas y partes de su solicitud","Confirmas que es buen momento antes de seguir"],"mejorar":[{"que":"Prometiste que el muro se podía tirar","accion":"Di que lo revisa el responsable técnico y fija tú la fecha de respuesta"},{"que":"Cerraste sin fecha ni responsable","accion":"Propón dos huecos y deja cerrada una llamada de control en 48-72 h"}],"duda":{"valor":false,"motivo":null},"objeciones":[{"tipo":"plazo","cita":"Me da miedo que la obra se alargue meses.","idea_contenido":"Vídeo: cómo planificamos una reforma integral para cumplir el plazo pactado"}]}`;

export function promptSistema(): string {
  return `${RUBRICA}\n\n${EJEMPLO}`;
}

export function promptUsuario(args: { rol: string; direccion: string; duracionSegundos: number; presupuestoRegistrado: boolean; transcripcion: string }): string {
  const min = Math.max(1, Math.round(args.duracionSegundos / 60));
  return `Contexto: rol ${args.rol} · llamada ${args.direccion === 'outbound' ? 'saliente' : 'entrante'} · ${min} min · presupuesto_registrado: ${args.presupuestoRegistrado ? 'sí' : 'no'}\n\nTranscripción:\n${args.transcripcion}`;
}

export type RespuestaModelo = { text: string; model: string; inputTokens: number | null; outputTokens: number | null };
export type Evaluador = (system: string, user: string) => Promise<RespuestaModelo>;

export class ModeloNoDisponible extends Error {}

export function evaluadorGemini(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Evaluador | null {
  const apiKey = env.GOOGLE_GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || '';
  if (!apiKey) return null;
  const model = env.CALIFICADOR_MODEL?.trim() || env.GOOGLE_GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';
  return async (system, user) => {
    let response: Response;
    try {
      response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ model, input: user, system_instruction: system, store: false,
          generation_config: { temperature: 0, thinking_level: env.CALIFICADOR_THINKING_LEVEL?.trim() || 'low', max_output_tokens: 4096 },
          response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA } }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) { throw new ModeloNoDisponible(`sin respuesta de Gemini: ${(error as Error).message}`); }
    if (!response.ok) throw new ModeloNoDisponible(`Gemini respondió HTTP ${response.status}`);
    const payload = await response.json().catch(() => { throw new ModeloNoDisponible('respuesta de Gemini ilegible'); }) as Record<string, unknown>;
    if (payload.status === 'incomplete') throw new ModeloNoDisponible('respuesta de Gemini incompleta');
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    const fromSteps = steps.filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object' && (s as Record<string, unknown>).type === 'model_output'))
      .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
      .map((c) => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string' ? String((c as Record<string, unknown>).text) : '')).join('');
    const text = String(typeof payload.output_text === 'string' ? payload.output_text : fromSteps).trim();
    if (!text) throw new ModeloNoDisponible('Gemini no devolvió texto');
    const usage = (payload.usage && typeof payload.usage === 'object' ? payload.usage : {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
    return { text, model, inputTokens: n(usage.total_input_tokens), outputTokens: n(usage.total_output_tokens) };
  };
}
