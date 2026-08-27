export type SpecialistRole = 'legal' | 'contabilidad' | 'ventas' | 'soporte' | 'general' | 'interiorista' | 'planimetrista' | 'director';

export interface SpecialistConfig {
  id: string;
  nombre: string;
  rol: SpecialistRole;
  system_prompt: string;
  modelo: 'flash' | 'pro';
}

export const specialists: SpecialistConfig[] = [
  { id: 'legal', nombre: 'Especialista Legal', rol: 'legal', system_prompt: 'Eres un especialista legal con conocimientos en derecho mercantil, contratos y normativa. Detecta urgencia en términos legales.', modelo: 'flash' },
  { id: 'contabilidad', nombre: 'Especialista Contabilidad', rol: 'contabilidad', system_prompt: 'Eres un especialista en contabilidad y finanzas. Analiza mensajes relacionados con facturas, pagos, balances y normativa fiscal.', modelo: 'flash' },
  { id: 'general', nombre: 'Copiloto General', rol: 'general', system_prompt: 'Eres un copiloto general que analiza conversaciones de WhatsApp para ayudar a resolver consultas de manera profesional.', modelo: 'flash' },
  { id: 'interiorista', nombre: 'Especialista Interiorista', rol: 'interiorista', system_prompt: 'Eres un especialista en interiorismo y decoracion. Evalua mensajes sobre ambientes, mobiliario, estilo, espacios y proyectos de diseno interior. Clasifica la urgencia y el estado del proyecto.', modelo: 'flash' },
  { id: 'planimetrista', nombre: 'Especialista Planimetrista', rol: 'planimetrista', system_prompt: 'Eres un especialista en planimetria y planos. Evalua mensajes sobre medidas, planos, tecnicas de dibujo, normativa constructiva y documentos tecnicos. Clasifica la urgencia y el estado del proyecto.', modelo: 'flash' },
  { id: 'director', nombre: 'Director de Proyecto', rol: 'director', system_prompt: 'Eres un director de proyecto. Evalua mensajes sobre avances, responsables, plazos, riesgos, bloqueos y coordinacion general. Clasifica la urgencia y el estado del proyecto.', modelo: 'flash' },
];

const DEFAULT_PROMPTS_BY_ID: Record<string, string> = {
  legal: 'Eres el especialista legal de una empresa. Usa solo hechos verificables del chat. Identifica cláusulas, obligaciones, riesgos contractuales, plazos o documentación pendiente. No des asesoría jurídica concluyente ni inventes normativa. Para una respuesta, redacta un mensaje prudente y profesional que solicite o confirme el dato necesario.',
  contabilidad: 'Eres el especialista contable y financiero de una empresa. Usa solo datos presentes en el chat. Distingue facturas, pagos, montos, soportes, conciliaciones, fechas de vencimiento y responsables. Nunca inventes importes, estados de pago ni obligaciones fiscales. Para una respuesta, pide la referencia o comprobante que falte de forma concreta.',
  general: 'Eres un copiloto operativo para conversaciones empresariales de WhatsApp. Analiza únicamente hechos explícitos. Distingue solicitudes, compromisos, decisiones, bloqueos y próximos pasos. Ignora stickers, reacciones y adjuntos sin transcripción como evidencia. Si no hay una solicitud accionable, dilo internamente y no inventes una respuesta. Cuando redactes una respuesta, debe ser natural, breve, en español y dirigida al último mensaje accionable.',
  interiorista: 'Eres el especialista de interiorismo de una empresa. Usa solo hechos del chat para identificar espacios, estilos, mobiliario, materiales, medidas, presupuesto, aprobaciones y entregables. No inventes especificaciones ni disponibilidad. Para una respuesta, aclara el siguiente dato de diseño o aprobación necesario con tono profesional.',
  planimetrista: 'Eres el especialista de planimetría y documentación técnica de una empresa. Usa solo hechos del chat para identificar planos, medidas, escalas, versiones, revisiones, normativa citada, archivos y responsables. No infieras dimensiones ni requisitos técnicos. Para una respuesta, confirma el plano, medida, versión o archivo específico que haga falta.',
  director: 'Eres el director de proyecto de una empresa. Usa solo hechos verificables del chat para identificar avance, responsables, plazos, dependencias, bloqueos, riesgos y decisiones. Prioriza lo que requiere seguimiento. No inventes asignaciones ni fechas. Para una respuesta, propone o confirma el siguiente paso concreto y su responsable cuando esté explícito.',
};

for (const specialist of specialists) {
  specialist.system_prompt = DEFAULT_PROMPTS_BY_ID[specialist.id] || specialist.system_prompt;
}

export function setSpecialists(list: SpecialistConfig[]) {
  specialists.length = 0;
  list.forEach((s) => specialists.push(s));
}

export function resolveSpecialist(id: string): SpecialistConfig | undefined {
  return specialists.find((s) => s.id === id);
}

export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export type GeminiMediaItem = {
  type: 'image' | 'audio' | 'video' | 'document';
  base64: string;
  mimeType: string;
};

export type GeminiExecutionResult = {
  text: string;
  provider: 'gemini' | 'local-fallback';
  model: string;
  fallback: boolean;
};

function localExecution(prompt: string, historial: string | undefined, systemInstruction: string | undefined): GeminiExecutionResult {
  return { text: localFallbackResponse(prompt, historial, systemInstruction), provider: 'local-fallback', model: 'local-rule-based', fallback: true };
}

function getModelId(modelo: 'flash' | 'pro'): string {
  if (modelo === 'pro') return process.env.GOOGLE_GEMINI_PRO_MODEL?.trim() || 'gemini-3.6-flash';
  return process.env.GOOGLE_GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';
}

function getApiKey(): string {
  return process.env.GOOGLE_GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || '';
}

function extractInteractionText(data: Record<string, unknown>): string {
  const directText = data.output_text ?? data.outputText;
  if (typeof directText === 'string' && directText.trim()) return directText.trim();

  const steps = Array.isArray(data.steps) ? data.steps : [];
  return steps
    .filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
    .map((content: any) => typeof content?.text === 'string' ? content.text : '')
    .filter(Boolean)
    .join('')
    .trim();
}

async function requestGeminiInteraction(
  prompt: string,
  input: unknown,
  modelId: string,
  systemInstruction: string | undefined,
  timeoutMs: number,
  historial: string | undefined,
): Promise<GeminiExecutionResult> {
  const apiKey = getApiKey();
  const configuredThinkingLevel = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  const thinkingLevel = ['minimal', 'low', 'medium', 'high'].includes(configuredThinkingLevel || '')
    ? configuredThinkingLevel
    : 'low';
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    store: false,
    generation_config: { thinking_level: thinkingLevel },
  };
  if (systemInstruction) body.system_instruction = systemInstruction;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(raw); } catch { /* ignore */ }

    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : typeof (data as any)?.error?.message === 'string' ? (data as any).error.message : raw.slice(0, 200);
      const lowerMessage = String(message).toLowerCase();
      console.error(`[gemini] Error HTTP ${response.status}: ${message}`);
      if (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 429 || lowerMessage.includes('api key') || lowerMessage.includes('quota') || lowerMessage.includes('rate limit') || lowerMessage.includes('free tier')) {
        return localExecution(prompt, historial, systemInstruction);
      }
      throw new GeminiError(response.status, message);
    }

    const text = extractInteractionText(data);
    console.log(`[gemini] Respuesta OK modelo=${modelId} chars=${text.length}`);
    const cleaned = cleanGeminiResponse(text);
    return { text: cleaned || '[sin respuesta de IA]', provider: 'gemini', model: modelId, fallback: false };
  } catch (error) {
    if ((error as any)?.name === 'AbortError') {
      console.error('[gemini] Timeout o aborto de la petición; usando fallback local');
      return localExecution(prompt, historial, systemInstruction);
    }
    const errStatus = (error as any)?.status;
    const errMessage = String((error as Error).message || '').toLowerCase();
    console.error(`[gemini] Excepción status=${errStatus} message=${(error as Error).message}`);
    if (errStatus === 400 || errStatus === 403 || errStatus === 404 || errStatus === 429 || errMessage.includes('quota') || errMessage.includes('rate limit') || errMessage.includes('free tier') || errMessage.includes('fetch failed') || errMessage.includes('network')) {
      return localExecution(prompt, historial, systemInstruction);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callGeminiWithPromptResult(prompt: string, modelo: 'flash' | 'pro' = 'flash', systemInstruction?: string, timeoutMs = 20_000, historial?: string): Promise<GeminiExecutionResult> {
  if (!getApiKey()) {
    console.error('[gemini] API key vacía o ausente; usando fallback local');
    return localExecution(prompt, historial, systemInstruction);
  }
  const modelId = getModelId(modelo);
  console.log(`[gemini] Usando Interactions API modelo=${modelo} modelId=${modelId} prompt_len=${prompt.length}`);
  return requestGeminiInteraction(prompt, prompt, modelId, systemInstruction, timeoutMs, historial);
}
export async function callGeminiWithPrompt(prompt: string, modelo: 'flash' | 'pro' = 'flash', systemInstruction?: string, timeoutMs = 20_000, historial?: string): Promise<string> {
  return (await callGeminiWithPromptResult(prompt, modelo, systemInstruction, timeoutMs, historial)).text;
}

function cleanGeminiResponse(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const fenced = text.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\s*```$/i);
  const normalized = fenced ? fenced[1].trim() : text;
  return normalized
    .replace(/`[^`]*`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getFallbackRoleGuidance(systemInstruction?: string): string {
  const instruction = String(systemInstruction || '').toLowerCase();
  if (/legal|contrato|normativa|juridic/.test(instruction)) return 'Revisaremos primero las implicaciones legales y la documentacion necesaria.';
  if (/contab|finanz|factura|pago|fiscal/.test(instruction)) return 'Revisaremos los importes, comprobantes y el siguiente paso financiero.';
  if (/venta|comercial|cliente|presupuesto/.test(instruction)) return 'Daremos seguimiento comercial y confirmaremos la informacion necesaria para avanzar.';
  if (/soporte|tecnic|incidencia/.test(instruction)) return 'Revisaremos la incidencia y compartiremos una actualizacion con los siguientes pasos.';
  if (/interior|diseno|mobiliario|ambiente/.test(instruction)) return 'Revisaremos los requerimientos de diseno y confirmaremos las decisiones pendientes.';
  if (/planimetr|plano|medida|construct/.test(instruction)) return 'Revisaremos las medidas y la documentacion tecnica antes de confirmar el avance.';
  if (/proyecto|plazo|riesgo|responsable/.test(instruction)) return 'Revisaremos responsables, plazos y bloqueos para definir el siguiente avance.';
  return systemInstruction ? 'Aplicaremos el criterio configurado para este rol antes de confirmar el siguiente paso.' : '';
}

type LocalHistoryMessage = { sender: string; text: string };

function parseLocalHistory(historial?: string): LocalHistoryMessage[] {
  return String(historial || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const dated = line.match(/^\d{2}\/\d{2}\s+\d{2}:\d{2}\s+-\s+([^:]+):\s*(.*)$/);
      const plain = line.match(/^([^:]+):\s*(.*)$/);
      const match = dated || plain;
      return {
        sender: String(match?.[1] || 'Contacto').trim(),
        text: String(match?.[2] || line).trim(),
      };
    })
    .filter((message) => Boolean(message.text));
}

function uniqueExcerpts(messages: LocalHistoryMessage[], pattern: RegExp, maxItems = 3): string[] {
  const seen = new Set<string>();
  const excerpts: string[] = [];
  for (const message of messages) {
    if (!pattern.test(message.text)) continue;
    const excerpt = `${message.sender}: ${message.text.replace(/\s+/g, ' ').slice(0, 260)}`;
    if (!seen.has(excerpt)) {
      seen.add(excerpt);
      excerpts.push(excerpt);
    }
    if (excerpts.length >= maxItems) break;
  }
  return excerpts;
}

function buildLocalSummary(historial?: string): string {
  const messages = parseLocalHistory(historial);
  if (!messages.length) return 'No hay mensajes suficientes para generar un resumen.';

  const latest = messages[messages.length - 1];
  const pending = uniqueExcerpts(messages, /\b(pendiente|necesito|necesitamos|puedes|pod[eé]s|podr[ií]as|enviar|revisar|confirmar|pagar|compartir|agendar|coordinar|urgente)\b/i);
  const progress = uniqueExcerpts(messages, /\b(confirmado|confirmamos|acuerdo|acordado|aprobado|listo|hecho|enviado|recibido|cerrado|avanzamos)\b/i);
  const blockers = uniqueExcerpts(messages, /\b(problema|error|bloqueado|bloqueo|esperando|retraso|demora|no puedo|no podemos|falta)\b/i);
  const keyData = uniqueExcerpts(messages, /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b(?:usd|u\$s|€|\$)\s?\d|\b\d+\s?(?:€|usd|u\$s)\b/i, 2);

  const sections = [
    'RESUMEN EJECUTIVO',
    `Se analizaron ${messages.length} mensajes recientes. Último intercambio: ${latest.sender}: ${latest.text.replace(/\s+/g, ' ').slice(0, 320)}`,
  ];

  if (pending.length) sections.push('PENDIENTES', ...pending.map((item) => `- ${item}`));
  if (progress.length) sections.push('ACUERDOS Y AVANCES', ...progress.map((item) => `- ${item}`));
  if (blockers.length) sections.push('RIESGOS O BLOQUEOS', ...blockers.map((item) => `- ${item}`));
  if (keyData.length) sections.push('DATOS CLAVE', ...keyData.map((item) => `- ${item}`));
  if (!pending.length && !progress.length && !blockers.length) sections.push('No se identifican pendientes, acuerdos ni bloqueos confirmados en el fragmento analizado.');

  return sections.join('\n');
}

function getCeoContextSection(context: string, section: string, nextSections: string[]): string[] {
  const start = context.indexOf(`${section}:`);
  if (start < 0) return [];
  const contentStart = start + section.length + 1;
  const ends = nextSections
    .map((next) => context.indexOf(`${next}:`, contentStart))
    .filter((index) => index >= 0);
  const end = ends.length ? Math.min(...ends) : context.length;
  return context.slice(contentStart, end).split('\n').map((line) => line.trim()).filter(Boolean);
}

function buildLocalCeoReport(context?: string): string {
  const source = String(context || '').trim();
  if (!source) return 'No hay datos empresariales suficientes para generar el reporte solicitado.';
  const period = source.match(/PERIODO ANALIZADO:\s*([^\n]+)/i)?.[1] || 'periodo consultado';
  const indicators = source.match(/INDICADORES:\s*([^\n]+)/i)?.[1] || 'Sin indicadores disponibles.';
  const roles = getCeoContextSection(source, 'CLASIFICACIONES Y ROLES', ['MENSAJES', 'RESUMENES GENERADOS', 'RESPUESTAS GENERADAS']).slice(0, 8);
  const messages = getCeoContextSection(source, 'MENSAJES', ['RESUMENES GENERADOS', 'RESPUESTAS GENERADAS']).slice(-8);
  const summaries = getCeoContextSection(source, 'RESUMENES GENERADOS', ['RESPUESTAS GENERADAS']).slice(0, 5);
  const replies = getCeoContextSection(source, 'RESPUESTAS GENERADAS', []).slice(0, 5);
  const sections = [
    'REPORTE EJECUTIVO',
    `Periodo: ${period}.`,
    `Indicadores: ${indicators}`,
  ];
  if (roles.length) sections.push('ROLES Y CLASIFICACIONES', ...roles.map((line) => `- ${line}`));
  if (messages.length) sections.push('SITUACIONES RECIENTES', ...messages.map((line) => `- ${line}`));
  if (summaries.length) sections.push('RESUMENES GENERADOS', ...summaries.map((line) => `- ${line}`));
  if (replies.length) sections.push('RESPUESTAS Y ROLES APLICADOS', ...replies.map((line) => `- ${line}`));
  return sections.join('\n');
}

function localFallbackResponse(prompt: string, historial?: string, systemInstruction?: string): string {
  const apiKey = getApiKey();
  const withoutKey = !apiKey;
  const roleGuidance = getFallbackRoleGuidance(systemInstruction);

  const lower = prompt.toLowerCase();
  if (/agente ejecutivo del ceo/i.test(String(systemInstruction || ''))) {
    return buildLocalCeoReport(historial);
  }
  if (lower.includes('resumen') || lower.includes('resumir') || lower.includes('analista empresarial') || lower.includes('resumen ejecutivo')) {
    return buildLocalSummary(historial);
  }
  if (lower.includes('resumen') || lower.includes('resumir') || lower.includes('analista empresarial') || lower.includes('resumen ejecutivo')) {
    const lines = String(historial || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!lines.length) {
      return 'No hay mensajes suficientes para generar un resumen.';
    }

    const participants = Array.from(new Set(lines.map((line) => line.split(':')[0]?.trim()).filter(Boolean))).slice(0, 6);
    const agreements = lines.filter((line) => /acuerdo|acordamos|confirmo|confirmado|cerrado|ok|dale|bueno|perfecto|nos vemos|mañana|coordinar/i.test(line));
    const tasks = lines.filter((line) => /pendiente|hay que|tengo que|necesito|pagar|enviar|compartir|confirmar|revisar|chequear|avanzar|cierre|firmar|presentar/i.test(line));
    const dates = lines.filter((line) => /mañana|lunes|martes|miércoles|jueves|viernes|semana|próximo|\d{1,2}\/\d{1,2}/i.test(line));
    const amounts = lines.filter((line) => /\$|pesos|u\$s|usd|pagar|factura|transferencia|dinero/i.test(line));

    const bullets: string[] = [];

    if (participants.length) {
      bullets.push(`Participantes identificados en la conversación: ${participants.join(', ')}.`);
    }
    if (agreements.length) {
      const sample = agreements.slice(0, 2).map((line) => line.replace(/^[^:]+:\s*/, '')).join('; ');
      bullets.push(`Se detectaron acuerdos o confirmaciones: ${sample}.`);
    }
    if (tasks.length) {
      const sample = tasks.slice(0, 3).map((line) => line.replace(/^[^:]+:\s*/, '')).join('; ');
      bullets.push(`Puntos pendientes detectados: ${sample}.`);
    }
    if (dates.length) {
      const sample = dates.slice(0, 2).map((line) => line.replace(/^[^:]+:\s*/, '')).join('; ');
      bullets.push(`Referencias temporales relevantes: ${sample}.`);
    }
    if (amounts.length) {
      const sample = amounts.slice(0, 2).map((line) => line.replace(/^[^:]+:\s*/, '')).join('; ');
      bullets.push(`Referencias comerciales o de pago: ${sample}.`);
    }
    if (!bullets.length) {
      bullets.push('No se detectaron puntos accionables claros en el fragmento analizado.');
    }

    return [roleGuidance, ...bullets].filter(Boolean).join('\n');
    }

  if (lower.includes('respuesta sugerida') || lower.includes('genera una respuesta') || lower.includes('respuesta unica')) {
    const last = String(historial || '').split('\n').filter(Boolean).slice(-2).join('\n');
    if (roleGuidance) {
      return `${roleGuidance} Gracias por la informacion compartida; confirmaremos el siguiente paso en cuanto validemos los datos necesarios.`;
    }
    if (!last) return 'Gracias por la información. Confirmo lo comentado y quedamos atentos para continuar con el próximo paso.';
    return `Sobre lo mencionado, confirmo que seguimos avanzando. Podemos cerrar ese punto y continuar con lo pendiente.`;
  }
  if (lower.includes('clasifica') || lower.includes('rol')) {
    return JSON.stringify({
      rol: 'general',
      confianza: 0.5,
      necesita_accion: false,
      urgencia: 'media',
    });
  }
  return withoutKey
    ? 'modo local: no hay datos locales suficientes para generar una respuesta más específica.'
    : 'No fue posible generar una respuesta con los datos locales disponibles.';
}

export async function callGeminiWithMediaResult(prompt: string, mediaItems: GeminiMediaItem[], modelo: 'flash' | 'pro' = 'flash', systemInstruction?: string, timeoutMs = 20_000, historial?: string): Promise<GeminiExecutionResult> {
  if (!getApiKey()) return localExecution(prompt, historial, systemInstruction);

  const input = [
    { type: 'text', text: prompt },
    ...mediaItems.map((item) => ({ type: item.type, data: item.base64, mime_type: item.mimeType })),
  ];
  const modelId = getModelId(modelo);
  console.log(`[gemini/media] Usando Interactions API modelo=${modelo} modelId=${modelId} media=${mediaItems.length}`);
  return requestGeminiInteraction(prompt, input, modelId, systemInstruction, timeoutMs, historial);
}
export async function callGeminiWithMedia(prompt: string, mediaItems: GeminiMediaItem[], modelo: 'flash' | 'pro' = 'flash', systemInstruction?: string, timeoutMs = 20_000, historial?: string): Promise<string> {
  return (await callGeminiWithMediaResult(prompt, mediaItems, modelo, systemInstruction, timeoutMs, historial)).text;
}
