import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callGeminiWithMediaResult, callGeminiWithPrompt, callGeminiWithPromptResult, resolveSpecialist, specialists, GeminiError } from '../geminiService';

describe('resolveSpecialist', () => {
  it('busca por id exacto', () => {
    expect(resolveSpecialist('legal')?.rol).toBe('legal');
  });

  it('retorna undefined para id inexistente', () => {
    expect(resolveSpecialist('no-existe')).toBeUndefined();
  });

  it('lista especialistas base', () => {
    expect(specialists.map((s) => s.id)).toEqual([
      'legal', 'contabilidad', 'general', 'interiorista', 'planimetrista', 'director',
    ]);
  });
});

describe('callGeminiWithMediaResult', () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-api-key';
  });

  it('usa Files para un vídeo grande y limpia después de fallar el análisis', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/qa' } }))
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/large', state: 'ACTIVE', uri: 'https://generativelanguage.googleapis.com/v1beta/files/large' } }))
      .mockResolvedValueOnce(Response.json({ error: 'Fallo IA QA' }, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    global.fetch = fetcher;
    await expect(callGeminiWithMediaResult('Analizar vídeo QA', [{ type: 'video', mimeType: 'video/mp4', base64: 'A'.repeat(17 * 1024 * 1024) }])).rejects.toThrow('Fallo IA QA');
    const body = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(body.input[1]).toEqual({ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/large' });
    expect(fetcher.mock.calls[3][1].method).toBe('DELETE');
  });

  it('conserva los tipos MIME de imágenes, audios, vídeos y documentos', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: 'Análisis listo' }),
    });

    const result = await callGeminiWithMediaResult('Analiza los adjuntos', [
      { type: 'image', base64: 'image-data', mimeType: 'image/jpeg' },
      { type: 'audio', base64: 'audio-data', mimeType: 'audio/ogg' },
      { type: 'video', base64: 'video-data', mimeType: 'video/mp4' },
      { type: 'document', base64: 'document-data', mimeType: 'application/pdf' },
    ], 'flash', 'Usa solo los archivos recibidos.');

    expect(result).toMatchObject({ text: 'Análisis listo', provider: 'gemini', fallback: false });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.input).toEqual([
      { type: 'text', text: 'Analiza los adjuntos' },
      { type: 'image', data: 'image-data', mime_type: 'image/jpeg' },
      { type: 'audio', data: 'audio-data', mime_type: 'audio/ogg' },
      { type: 'video', data: 'video-data', mime_type: 'video/mp4' },
      { type: 'document', data: 'document-data', mime_type: 'application/pdf' },
    ]);
    expect(body.system_instruction).toBe('Usa solo los archivos recibidos.');
    expect(body.store).toBe(false);
  });
});
describe('callGeminiWithPrompt', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GOOGLE_GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-api-key';
  });

  it('llama a Gemini y devuelve texto', async () => {
    const mockResponse = {
      output_text: 'Hola desde Gemini',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockResponse),
    });

    const result = await callGeminiWithPrompt('Decime hola', 'flash');
    expect(result).toBe('Hola desde Gemini');
  });

  it('usa system instruction cuando se provee', async () => {
    const mockResponse = {
      output_text: 'Respuesta',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockResponse),
    });

    await callGeminiWithPrompt('Consulta', 'pro', 'Sos un asistente');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch.mock.calls[0] as any[])[1].body);
    expect(body.system_instruction).toBe('Sos un asistente');
    expect(body.model).toBe('gemini-3.6-flash');
    expect(body.input).toBe('Consulta');
    expect((global.fetch.mock.calls[0] as any[])[0]).toContain('/interactions');
  });

  it('falla si no hay GOOGLE_API_KEY', async () => {
    process.env.GOOGLE_API_KEY = '';
    await expect(callGeminiWithPrompt('Consulta')).resolves.toContain('modo local');
  });

  it('identifica de forma explícita una respuesta de fallback local', async () => {
    process.env.GOOGLE_API_KEY = '';

    const result = await callGeminiWithPromptResult('Consulta');

    expect(result.provider).toBe('local-fallback');
    expect(result.model).toBe('local-rule-based');
    expect(result.fallback).toBe(true);
    expect(result.text).toContain('modo local');
  });

  it('genera un resumen local concreto sin confundir fechas con remitentes', async () => {
    process.env.GOOGLE_API_KEY = '';
    const historial = [
      '10/08 09:00 - Cliente: Necesito confirmar el presupuesto para el viernes.',
      '10/08 09:05 - YO: Presupuesto enviado por USD 1200.',
      '10/08 09:10 - Cliente: Perfecto, lo reviso hoy.',
    ].join('\n');

    const result = await callGeminiWithPrompt('Genera un resumen ejecutivo', 'flash', undefined, 20_000, historial);

    expect(result).toContain('Cliente: Necesito confirmar el presupuesto para el viernes.');
    expect(result).toContain('YO: Presupuesto enviado por USD 1200.');
    expect(result).not.toContain('10/08 09');
  });

  it('genera un reporte ejecutivo local con el contexto del CEO', async () => {
    process.env.GOOGLE_API_KEY = '';
    const contexto = 'PERIODO ANALIZADO: ultimos 7 dias.\nINDICADORES: 12 mensajes, 3 chats activos, 2 mensajes no leidos.\n\nCLASIFICACIONES Y ROLES:\nRol legal; urgencia alta; requiere accion si: 1 mensajes.\n\nMENSAJES:\nCliente: Necesito revisar el contrato.\n\nRESUMENES GENERADOS:\nResumen de Cliente; rol usado: Especialista Legal.\n\nRESPUESTAS GENERADAS:\nRespuesta para Cliente; rol usado: Especialista Legal.';

    const result = await callGeminiWithPrompt('Genera un reporte semanal', 'flash', 'Eres el agente ejecutivo del CEO.', 20_000, contexto);

    expect(result).toContain('REPORTE EJECUTIVO');
    expect(result).toContain('12 mensajes, 3 chats activos');
    expect(result).toContain('Especialista Legal');
  });

  it('maneja error de Gemini', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'boom' }),
    });

    await expect(callGeminiWithPrompt('Consulta', 'pro')).rejects.toThrow('boom');
  });

  it.each([[429, true], [403, false]])('clasifica HTTP %s para reintentos de lotes', async (status, retryable) => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Error sintético' }), { status: Number(status) }));
    await expect(callGeminiWithPromptResult('Consulta')).resolves.toMatchObject({ fallback: true, retryable });
  });

  it('clasifica los fallos de red como recuperables sin presentarlos como análisis válidos', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(callGeminiWithPromptResult('Consulta')).resolves.toMatchObject({ provider: 'local-fallback', fallback: true, retryable: true });
  });

  it('maneja timeout', async () => {
    global.fetch = vi.fn().mockImplementation((_url, options?: any) => {
      const { signal } = options || {};
      let rejectFn: (reason?: any) => void;
      const promise = new Promise((_, reject) => {
        rejectFn = reject;
      });

      signal?.addEventListener('abort', () => {
        const error = new Error('Aborted');
        (error as any).name = 'AbortError';
        rejectFn(error);
      });

      return promise;
    });

    await expect(callGeminiWithPrompt('Consulta', 'flash', undefined, 100))
      .resolves.toContain('datos locales');
  });

  it('maneja el aborto reportado por Node sin AbortError', async () => {
    global.fetch = vi.fn().mockImplementation((_url, options?: any) => {
      const { signal } = options || {};
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new TypeError('signal is aborted without reason')));
      });
    });

    await expect(callGeminiWithPrompt('Consulta', 'flash', undefined, 100))
      .resolves.toContain('datos locales');
  });
  it('conserva citas literales con Markdown dentro de JSON', async () => {
    const text = JSON.stringify({ quote: 'El importe **no** es `9000`: son 1200.' });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ output_text: text }) });
    await expect(callGeminiWithPrompt('Devuelve citas')).resolves.toBe(text);
  });

  it('conserva JSON válido cuando Gemini lo devuelve en un bloque de código', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: '```json\n{"summary":"Resumen válido"}\n```' }),
    });

    await expect(callGeminiWithPrompt('Devuelve JSON')).resolves.toBe('{"summary":"Resumen válido"}');
  });

  it('rechaza una respuesta sin texto y no la presenta como análisis válido', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ steps: [] }),
    });

    await expect(callGeminiWithPromptResult('Consulta', 'flash')).rejects.toMatchObject({status:502});
  });
});
