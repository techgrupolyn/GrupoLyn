import { setTimeout as delay } from 'node:timers/promises';

const apiOrigin = 'https://generativelanguage.googleapis.com';
type GeminiFile = { name: string; uri: string; state: string };

export async function uploadGeminiFile(base64: string, mimeType: string, apiKey: string, signal: AbortSignal, uploadedNames: string[]): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const started = await fetch(`${apiOrigin}/upload/v1beta/files`, {
    method: 'POST', signal, redirect: 'error',
    headers: {
      'x-goog-api-key': apiKey, 'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify({ file: { display_name: 'Adjunto de resumen' } }),
  });
  if (!started.ok) throw new Error(`No se pudo iniciar adjunto Gemini: HTTP ${started.status}`);
  const uploadUrl = new URL(started.headers.get('x-goog-upload-url') || '');
  if (uploadUrl.origin !== apiOrigin) throw new Error('Destino de subida Gemini no autorizado');
  const uploaded = await fetch(uploadUrl, {
    method: 'POST', signal, redirect: 'error',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type': mimeType },
    body: buffer,
  });
  if (!uploaded.ok) throw new Error(`No se pudo subir adjunto Gemini: HTTP ${uploaded.status}`);
  let file = (await uploaded.json() as { file: GeminiFile }).file;
  if (!file?.name || !/^files\/[a-zA-Z0-9_-]+$/.test(file.name)) throw new Error('Referencia de archivo Gemini inválida');
  const name = file.name;
  uploadedNames.push(name);
  while (file.state === 'PROCESSING') {
    await delay(1000, undefined, { signal });
    const status = await fetch(`${apiOrigin}/v1beta/${name}`, { headers: { 'x-goog-api-key': apiKey }, signal, redirect: 'error' });
    if (!status.ok) throw new Error(`No se pudo comprobar adjunto Gemini: HTTP ${status.status}`);
    file = await status.json() as GeminiFile;
  }
  if (file.state !== 'ACTIVE' || !file.uri || new URL(file.uri).origin !== apiOrigin) throw new Error('Gemini no pudo preparar el adjunto');
  return file.uri;
}

export async function deleteGeminiFiles(names: string[], apiKey: string): Promise<void> {
  for (const name of names) {
    try {
      const response = await fetch(`${apiOrigin}/v1beta/${name}`, {
        method: 'DELETE', headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    } catch {
      console.warn('[gemini/files] No se pudo eliminar un archivo temporal; comprobar retención del proveedor');
    }
  }
}
