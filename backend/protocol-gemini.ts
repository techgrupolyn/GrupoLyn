const schema = {
  type: 'object',
  properties: {
    clasificacion: { type: 'string', enum: ['resuelta', 'no_urgente', 'urgente', 'aclaracion'] },
    respuesta: { type: 'string' },
    fuentes: { type: 'array', items: { type: 'object', properties: { doc_id: { type: 'string' }, seccion: { type: 'string' }, cita: { type: 'string' } }, required: ['doc_id', 'seccion', 'cita'] } },
    motivo_no_respuesta: { type: ['string', 'null'], enum: ['sin_protocolo', 'fuera_de_alcance', 'tema_sensible', null] },
    cargo_derivacion: { type: ['string', 'null'] },
    contradiccion: { type: ['object', 'null'], properties: { doc_a: { type: 'string' }, doc_b: { type: 'string' }, descripcion: { type: 'string' } }, required: ['doc_a', 'doc_b', 'descripcion'] },
    area: { type: 'string', enum: ['diseno', 'presupuestos', 'materiales', 'obra', 'revisiones_y_reuniones', 'responsables_y_escalado', 'uso_de_club_lyn', 'otro'] },
    tema: { type: 'string' },
  },
  required: ['clasificacion', 'respuesta', 'fuentes', 'motivo_no_respuesta', 'cargo_derivacion', 'contradiccion', 'area', 'tema'],
};

export async function callProtocolGemini(system: string, user: string, options: { apiKey?: string; model?: string; fetcher?: typeof fetch } = {}): Promise<{ text: string; model: string; inputTokens: number | null; outputTokens: number | null }> {
  const apiKey = options.apiKey || process.env.GOOGLE_GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || '';
  if (!apiKey) throw new Error('Modelo no disponible');
  const model = options.model || process.env.PROTOCOL_MODEL?.trim() || process.env.GOOGLE_GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';
  let response: Response;
  try {
    response = await (options.fetcher || fetch)('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ model, input: user, system_instruction: system, store: false, generation_config: { temperature: 0, thinking_level: 'low', max_output_tokens: 4096 }, response_format: { type: 'text', mime_type: 'application/json', schema } }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new Error('Modelo no disponible'); }
  if (!response.ok) throw new Error('Modelo no disponible');
  const payload = await response.json().catch(() => { throw new Error('Modelo no disponible'); }) as Record<string, unknown>;
  if (payload.status === 'incomplete') throw new Error('Modelo no disponible');
  const output = typeof payload.output_text === 'string' ? payload.output_text : typeof payload.outputText === 'string' ? payload.outputText : '';
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const fromSteps = steps.filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object' && (step as Record<string, unknown>).type === 'model_output'))
    .flatMap(step => Array.isArray(step.content) ? step.content : [])
    .map(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : '')
    .join('');
  const text = (output || fromSteps).trim();
  if (!text) throw new Error('Modelo no disponible');
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {};
  const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { text, model, inputTokens: tokenCount(usage.total_input_tokens), outputTokens: tokenCount(usage.total_output_tokens) };
}

export async function transcribeProtocolTable(image: Buffer, options: { apiKey?: string; model?: string; expectedColumns?: number; structuredRows?: boolean; fetcher?: typeof fetch } = {}): Promise<string> {
  const apiKey = options.apiKey || process.env.GOOGLE_GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || '';
  if (!apiKey) throw new Error('Modelo de visión no disponible');
  const model = options.model || process.env.PROTOCOL_VISION_MODEL?.trim() || process.env.GOOGLE_GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';
  const structuredRows = options.structuredRows === true && Number.isSafeInteger(options.expectedColumns) && options.expectedColumns! >= 2 && options.expectedColumns! <= 20;
  const columnKeys = structuredRows ? Array.from({ length: options.expectedColumns! }, (_, index) => `c${index + 1}`) : [];
  const responseSchema = structuredRows
    ? { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: Object.fromEntries(columnKeys.map(key => [key, { type: 'string' }])), required: columnKeys } } }, required: ['rows'] }
    : { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] };
  let response: Response;
  try {
    response = await (options.fetcher || fetch)('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ model, store: false, input: [
        { type: 'text', text: `${structuredRows ? `Transcribe todas las filas de la tabla visible como objetos JSON con claves ${columnKeys.join(', ')}, sin fila separadora de Markdown.` : 'Transcribe todas las tablas visibles de esta página en Markdown.'} Conserva el orden, las columnas, las filas, las celdas vacías y el texto exacto.${options.expectedColumns ? ` La tabla tiene ${options.expectedColumns} columnas: escribe exactamente ${options.expectedColumns} celdas en cada fila, incluidas las vacías.` : ''} No añadas encabezados, explicaciones ni palabras que no aparezcan en la imagen. Devuelve solo el JSON solicitado.` },
        { type: 'image', data: image.toString('base64'), mime_type: 'image/jpeg' },
      ], generation_config: { temperature: 0, thinking_level: 'low', max_output_tokens: 8192 }, response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema } }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch { throw new Error('Modelo de visión no disponible'); }
  if (!response.ok) throw new Error(`Modelo de visión no disponible (${response.status})`);
  const payload = await response.json().catch(() => { throw new Error('Modelo de visión no disponible'); }) as Record<string, unknown>;
  if (payload.status === 'incomplete') throw new Error('Modelo de visión no disponible');
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const fromSteps = steps.filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object' && (step as Record<string, unknown>).type === 'model_output'))
    .flatMap(step => Array.isArray(step.content) ? step.content : [])
    .map(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : '')
    .join('');
  const output = typeof payload.output_text === 'string' ? payload.output_text : fromSteps;
  try {
    const parsed = JSON.parse(output) as { markdown?: unknown; rows?: unknown };
    if (structuredRows && Array.isArray(parsed.rows) && parsed.rows.length >= 2 && parsed.rows.every(row => row !== null && typeof row === 'object' && columnKeys.every(key => typeof row[key] === 'string'))) {
      return parsed.rows.map(row => `| ${columnKeys.map(key => row[key].replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|')).join(' | ')} |`).join('\n');
    }
    if (typeof parsed.markdown === 'string' && parsed.markdown.trim()) return parsed.markdown.trim();
  } catch {}
  throw new Error('Modelo de visión devolvió una transcripción inválida');
}
