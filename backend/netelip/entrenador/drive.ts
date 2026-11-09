// Publicación del .docx en Google Drive con el permiso drive.file: la app solo puede tocar los archivos
// que ella crea. El primer envío crea el archivo; los siguientes lo sustituyen, así el enlace no cambia.
import { MIME_DOCX } from './docx.ts';

export type ArchivoDrive = { id: string; url: string; enCarpeta: boolean };
export class DriveNoDisponible extends Error {}

const API = 'https://www.googleapis.com/upload/drive/v3/files';
const CAMPOS = 'fields=id,webViewLink,parents&supportsAllDrives=true';

async function leer(response: Response, accion: string): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detalle = (body.error as { message?: string } | undefined)?.message || `HTTP ${response.status}`;
    throw Object.assign(new DriveNoDisponible(`${accion}: ${detalle}`), { status: response.status });
  }
  return body;
}

function multipart(metadata: Record<string, unknown>, contenido: Buffer): { body: Buffer; type: string } {
  const limite = `lyn-${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${limite}\r\nContent-Type: ${MIME_DOCX}\r\n\r\n`),
    contenido,
    Buffer.from(`\r\n--${limite}--`),
  ]);
  return { body, type: `multipart/related; boundary=${limite}` };
}

/**
 * Sube el .docx. Con `fileId` sustituye el contenido del mismo archivo. Sin él, lo crea en `carpetaId`;
 * si drive.file no deja usar esa carpeta (Google no la «ve» porque no la creó la app), lo crea en la raíz
 * de la cuenta: basta con moverlo una vez a la carpeta y las siguientes versiones lo seguirán actualizando.
 */
export async function publicarDocx(args: { token: string; carpetaId: string; fileId: string | null; nombre: string; contenido: Buffer; fetcher?: typeof fetch }): Promise<ArchivoDrive> {
  const fetcher = args.fetcher || fetch;
  const auth = { Authorization: `Bearer ${args.token}` };
  if (args.fileId) {
    try {
      const body = await leer(await fetcher(`${API}/${encodeURIComponent(args.fileId)}?uploadType=media&${CAMPOS}`, {
        method: 'PATCH', headers: { ...auth, 'Content-Type': MIME_DOCX }, body: args.contenido, signal: AbortSignal.timeout(60_000),
      }), 'actualizar el archivo');
      const parents = Array.isArray(body.parents) ? body.parents : [];
      return { id: String(body.id), url: String(body.webViewLink || ''), enCarpeta: parents.includes(args.carpetaId) };
    } catch (error) {
      // Borrado en Drive o sin acceso: se crea de nuevo (el enlace cambia y se avisa en el Dashboard).
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  const crear = async (parents: string[]) => {
    const { body, type } = multipart({ name: args.nombre, mimeType: MIME_DOCX, ...(parents.length ? { parents } : {}) }, args.contenido);
    return leer(await fetcher(`${API}?uploadType=multipart&${CAMPOS}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': type }, body, signal: AbortSignal.timeout(60_000),
    }), 'crear el archivo');
  };
  try {
    const body = await crear([args.carpetaId]);
    return { id: String(body.id), url: String(body.webViewLink || ''), enCarpeta: true };
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    const body = await crear([]);
    return { id: String(body.id), url: String(body.webViewLink || ''), enCarpeta: false };
  }
}

/** ID de carpeta desde el ID o desde su enlace (…/drive/folders/<id>?usp=…). */
export function idCarpetaDrive(raw: string | undefined): string | null {
  const value = String(raw || '').trim();
  const id = /\/folders\/([\w-]{10,})/.exec(value)?.[1] || (/^[\w-]{10,}$/.test(value) ? value : null);
  return id || null;
}
