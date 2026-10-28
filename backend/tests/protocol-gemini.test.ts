import { describe, expect, it, vi } from 'vitest';
import { callProtocolGemini } from '../protocol-gemini.ts';

describe('Gemini para protocolos', () => {
  it('reserva salida suficiente y reduce el razonamiento', async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ text: '{"ok":true}' }] }] }), { status: 200 }));
    const result = await callProtocolGemini('sistema', 'pregunta', { apiKey: 'test-only', fetcher });
    expect(result.text).toBe('{"ok":true}');
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request.generation_config).toEqual({ temperature: 0, thinking_level: 'low', max_output_tokens: 4096 });
    expect(request.store).toBe(false);
  });

  it('rechaza salidas incompletas antes de intentar analizar su JSON', async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(JSON.stringify({ status: 'incomplete', steps: [{ type: 'model_output', content: [{ text: '{"clasificacion":' }] }] }), { status: 200 }));
    await expect(callProtocolGemini('sistema', 'pregunta', { apiKey: 'test-only', fetcher })).rejects.toThrow('Modelo no disponible');
  });

  it('recupera el uso de tokens sin contenido de la respuesta', async () => {
    const fetcher = vi.fn(async () => Response.json({ output_text: '{"ok":true}', usage: { total_input_tokens: 120, total_output_tokens: 34 } }));
    const result = await callProtocolGemini('sistema', 'pregunta', { apiKey: 'test-only', fetcher });
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(34);
  });

  it('permite un modelo propio sin cambiar el modelo global de otros agentes', async () => {
    vi.stubEnv('PROTOCOL_MODEL', 'gemini-3.5-flash-lite');
    vi.stubEnv('GOOGLE_GEMINI_FLASH_MODEL', 'gemini-3.6-flash');
    try {
      const fetcher = vi.fn(async () => Response.json({ output_text: '{"ok":true}' }));
      await callProtocolGemini('sistema', 'pregunta', { apiKey: 'test-only', fetcher });
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).model).toBe('gemini-3.5-flash-lite');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
