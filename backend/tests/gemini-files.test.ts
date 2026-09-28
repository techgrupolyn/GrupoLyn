import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteGeminiFiles, uploadGeminiFile } from '../gemini-files.ts';

afterEach(() => vi.unstubAllGlobals());

describe('adjuntos temporales Gemini', () => {
  it('sube bytes, espera ACTIVE y elimina únicamente el archivo creado', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/qa' } }))
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/qa', state: 'PROCESSING' } }))
      .mockResolvedValueOnce(Response.json({ name: 'files/qa', state: 'ACTIVE', uri: 'https://generativelanguage.googleapis.com/v1beta/files/qa' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const names: string[] = [];
    const uri = await uploadGeminiFile('cWE=', 'video/mp4', 'test-key', AbortSignal.timeout(5000), names);
    expect(uri).toContain('/files/qa');
    expect(names).toEqual(['files/qa']);
    expect(fetcher.mock.calls[1][1].body.toString()).toBe('qa');
    await deleteGeminiFiles(names, 'test-key');
    expect(fetcher.mock.calls[3][1].method).toBe('DELETE');
  });

  it('rechaza destinos ajenos sin transmitir los bytes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { headers: { 'x-goog-upload-url': 'https://example.test/upload' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(uploadGeminiFile('cWE=', 'video/mp4', 'test-key', AbortSignal.timeout(5000), [])).rejects.toThrow('no autorizado');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('registra para limpieza un archivo cuyo procesamiento falla', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/qa' } }))
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/failed', state: 'FAILED' } })));
    const names: string[] = [];
    await expect(uploadGeminiFile('cWE=', 'video/mp4', 'test-key', AbortSignal.timeout(5000), names)).rejects.toThrow('no pudo preparar');
    expect(names).toEqual(['files/failed']);
  });
});
