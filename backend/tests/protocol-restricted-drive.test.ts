import { describe, expect, it, vi } from 'vitest';
import { syncRestrictedProtocolDrive } from '../protocol-restricted-drive.ts';

const folderId = 'club-folder';

function request(path: string): Promise<Response> {
  const parent = new URL(path, 'https://drive.test').searchParams.get('q');
  if (parent?.includes(`'${folderId}'`)) return Promise.resolve(Response.json({ files: [
    { id: 'main-copy', name: 'Control.pdf', mimeType: 'application/pdf', version: '1', parents: [folderId] },
    { id: 'notes-folder', name: 'Notas', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
    { id: 'old-folder', name: '_Obsoletos', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
    { id: 'price', name: 'Cotizador.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', version: '2', parents: [folderId] },
  ] }));
  if (parent?.includes("'notes-folder'")) return Promise.resolve(Response.json({ files: [
    { id: 'notes', name: 'Notas de reunión.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', version: '3', parents: ['notes-folder'] },
  ] }));
  if (parent?.includes("'old-folder'")) throw new Error('No se deben leer los obsoletos');
  return Promise.resolve(new Response(Buffer.from('contenido privado')));
}

describe('sincronización privada de Protocolos', () => {
  it('guarda solo fuentes heredadas únicas en el lote privado, sin enviarlas al modelo', async () => {
    const save = vi.fn(async () => undefined);
    const extract = vi.fn(async () => ({ sections: [{ ref: 'hoja 1', text: 'Cliente privado, precio de 1200 euros' }], warnings: [] }));
    const report = await syncRestrictedProtocolDrive(request, {
      folderId, generalFiles: [{ id: 'main-copy', name: 'Control.pdf', mimeType: 'application/pdf', audience: 'general', modifiedTime: '', revision: '1', sections: [{ ref: 'página 1', text: 'General' }], warnings: [] }],
      previousFiles: [], save, extract,
    });
    expect(report).toEqual({ fileCount: 2, error: null });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].map(file => file.id)).toEqual(['price', 'notes']);
    expect(save.mock.calls[0][0].every(file => file.audience === 'restricted')).toBe(true);
    expect(extract.mock.calls.every(call => call[3] === 5000)).toBe(true);
  });

  it('conserva la versión anterior si un documento no puede verificarse', async () => {
    const save = vi.fn(async () => undefined);
    const report = await syncRestrictedProtocolDrive(request, {
      folderId, generalFiles: [], previousFiles: [], save,
      extract: async () => ({ sections: [], warnings: ['sin capa de texto'] }),
    });
    expect(report.error).toContain('pendiente de verificación visual');
    expect(save).not.toHaveBeenCalled();
  });

  it('reutiliza una revisión ya almacenada sin volver a leer sus bytes', async () => {
    const save = vi.fn(async () => undefined);
    const fetch = vi.fn(request);
    const previousFile = { id: 'price', name: 'Cotizador.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', audience: 'restricted' as const, modifiedTime: '', revision: '2', extractionVersion: 4, sections: [{ ref: 'hoja 1', text: 'Precio privado' }], warnings: [] };
    const report = await syncRestrictedProtocolDrive(fetch, {
      folderId, generalFiles: [], previousFiles: [previousFile], save,
      extract: async () => ({ sections: [{ ref: 'página 1', text: 'Texto' }], warnings: [] }),
    });
    expect(report.error).toBeNull();
    expect(fetch.mock.calls.some(([path]) => path.includes('/files/price?'))).toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });

  it('no crea otra generación si todo el inventario conserva la misma revisión', async () => {
    const save = vi.fn(async () => undefined);
    const fetch = vi.fn(request);
    const previousFiles = [
      { id: 'main-copy', name: 'Control.pdf', mimeType: 'application/pdf', audience: 'restricted' as const, modifiedTime: '', revision: '1', extractionVersion: 4, sections: [{ ref: 'página 1', text: 'Texto' }], warnings: [] },
      { id: 'price', name: 'Cotizador.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', audience: 'restricted' as const, modifiedTime: '', revision: '2', extractionVersion: 4, sections: [{ ref: 'hoja 1', text: 'Precio privado' }], warnings: [] },
      { id: 'notes', name: 'Notas de reunión.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', audience: 'restricted' as const, modifiedTime: '', revision: '3', extractionVersion: 4, sections: [{ ref: 'párrafo 1', text: 'Nota privada' }], warnings: [] },
    ];
    const report = await syncRestrictedProtocolDrive(fetch, { folderId, generalFiles: [], previousFiles, save });
    expect(report).toEqual({ fileCount: 3, error: null });
    expect(save).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([path]) => path.startsWith('/files?'))).toBe(true);
  });
});
