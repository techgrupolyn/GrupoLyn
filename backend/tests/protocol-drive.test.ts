import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { syncProtocolDrive } from '../protocol-drive.ts';

const folderId = '14oB0TKbGyvEDMti2JgjXIep54-ZcMbc_';

describe('sincronización de protocolos', () => {
  it('une la carpeta anterior, incluye subcarpetas válidas y evita copias idénticas', async () => {
    const legacyFolderId = 'club-protocolos';
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => {
      const parent = new URL(path, 'https://drive.test').searchParams.get('q');
      if (parent?.includes(`'${folderId}'`)) return Response.json({ files: [
        { id: 'main-copy', name: 'Materiales.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', version: '1', md5Checksum: 'same', parents: [folderId] },
      ] });
      if (parent?.includes(`'${legacyFolderId}'`)) return Response.json({ files: [
        { id: 'club-copy', name: 'Materiales.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', version: '1', md5Checksum: 'same', parents: [legacyFolderId] },
        { id: 'club-only', name: 'Interiorismo.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', version: '1', md5Checksum: 'unique', parents: [legacyFolderId] },
        { id: 'pm-folder', name: 'PM', mimeType: 'application/vnd.google-apps.folder', parents: [legacyFolderId] },
        { id: 'obsolete-folder', name: '_Obsoletos', mimeType: 'application/vnd.google-apps.folder', parents: [legacyFolderId] },
      ] });
      if (parent?.includes("'pm-folder'")) return Response.json({ files: [
        { id: 'pm-only', name: 'Certificaciones.pdf', mimeType: 'application/pdf', version: '1', md5Checksum: 'pm', parents: ['pm-folder'] },
      ] });
      return new Response(Buffer.from('archivo'));
    });
    const extract = vi.fn(async () => ({ sections: [{ ref: 'página 1', text: 'Texto de protocolo verificable' }], warnings: [] }));
    const report = await syncProtocolDrive(request, { maxTokens: 1000, legacyFolderId, save, extract });
    expect(report.error).toBeNull();
    expect(report.files.map(file => file.id)).toEqual(['main-copy', 'club-only', 'pm-only']);
    expect(save.mock.calls[0][0].files.map(file => file.id).sort()).toEqual(['club-only', 'main-copy', 'pm-only']);
    expect(request.mock.calls.filter(([path]) => path.startsWith('/files?'))).toHaveLength(3);
  });

  it('conserva el corpus anterior si falla la carpeta adicional', async () => {
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => path.includes(`'${folderId}'`)
      ? Response.json({ files: [] })
      : new Response(null, { status: 403 }));
    const report = await syncProtocolDrive(request, { maxTokens: 1000, legacyFolderId: 'club-protocolos', save });
    expect(report.error).toContain('Google Drive respondió 403');
    expect(save).not.toHaveBeenCalled();
  });

  it('excluye subcarpetas y retira plantillas que entraron en un corpus anterior', async () => {
    const save = vi.fn(async () => undefined);
    const previous = {
      id: 'version-anterior', createdAt: '2026-11-02T00:00:00Z', tokenEstimate: 100,
      files: [
        { id: 'doc-1', name: 'Normas', mimeType: 'text/plain', revision: '1', modifiedTime: '', extractionVersion: 4, sections: [{ ref: 'texto', text: 'Normas del equipo' }], warnings: [] },
        { id: 'template-1', name: 'Plantilla.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', revision: '1', modifiedTime: '', extractionVersion: 4, sections: [{ ref: 'hoja 1', text: 'Presupuesto orientativo' }], warnings: [] },
      ],
      documents: [],
    };
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/files?')) throw new Error('No debe leer el contenido de una subcarpeta');
      const parent = new URL(path, 'https://drive.test').searchParams.get('q');
      if (!parent?.includes(`'${folderId}'`)) throw new Error('No debe listar una subcarpeta');
      return Response.json({ files: [
        { id: 'doc-1', name: 'Normas', mimeType: 'text/plain', version: '1', parents: [folderId] },
        { id: 'folder-q', name: 'Plantillas Quantifier', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
        { id: 'folder-old', name: '_Obsoletos', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
      ] });
    });
    const report = await syncProtocolDrive(request, { maxTokens: 1000, previous, save });
    expect(report.error).toBeNull();
    expect(report.files.map(file => file.id)).toEqual(['doc-1']);
    expect(save.mock.calls[0][0].files.map(file => file.id)).toEqual(['doc-1']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('incluye la hoja externa autorizada sin moverla a la carpeta de protocolos', async () => {
    const save = vi.fn(async () => undefined);
    const sheetId = '1H43otMwHAzD724u-e2s8czAoNLnxCW95kOUm3bNhG3w';
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/files?')) return Response.json({ files: [{ id: 'doc-1', name: 'Normas', mimeType: 'text/plain', version: '1', parents: [folderId] }] });
      if (path.startsWith(`/files/${sheetId}?`)) return Response.json({ id: sheetId, name: 'Reparto de obras', mimeType: 'application/vnd.google-apps.spreadsheet', version: '2', trashed: false });
      return new Response(Buffer.from('contenido'));
    });
    const extract = vi.fn(async (kind: string) => ({ sections: [{ ref: kind === 'assignments' ? 'PM DELINEANTE!B11' : 'texto', text: kind === 'assignments' ? 'Obra: Mar jonica; PMC: Lunilse' : 'Normas del equipo' }], warnings: [] }));
    const report = await syncProtocolDrive(request, { maxTokens: 1000, assignmentsSheetId: sheetId, save, extract });
    expect(report.error).toBeNull();
    expect(report.files).toHaveLength(2);
    expect(extract.mock.calls.map(call => call[0])).toContain('assignments');
    expect(save.mock.calls[0][0].files.find(file => file.id === sheetId)?.sections[0].text).toContain('Mar jonica');
  });

  it('conserva el corpus anterior si la hoja externa no se puede leer', async () => {
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => path.startsWith('/files?') ? Response.json({ files: [] }) : new Response(null, { status: 404 }));
    const report = await syncProtocolDrive(request, { maxTokens: 1000, assignmentsSheetId: '1H43otMwHAzD724u-e2s8czAoNLnxCW95kOUm3bNhG3w', save });
    expect(report.error).toContain('Google Drive respondió 404');
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['pdf', 'application/pdf', 'página 2: sin capa de texto; excluida'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'hoja 1: se alcanzó el límite de 500 filas'],
  ])('no publica un %s parcialmente extraído', async (_kind, mimeType, warning) => {
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => path.startsWith('/files?')
      ? Response.json({ files: [{ id: 'doc-1', name: `documento.${_kind}`, mimeType, version: '1', modifiedTime: '2026-10-28T00:00:00Z', parents: [folderId] }] })
      : new Response(Buffer.from('documento local')));
    const extract = vi.fn(async () => ({ sections: [{ ref: 'página 1', text: 'Contenido verificable' }], warnings: [warning], visionPages: [] }));
    const report = await syncProtocolDrive(request, { maxTokens: 1000, save, extract });
    expect(report.error).toContain('se conserva el corpus anterior');
    expect(save).not.toHaveBeenCalled();
  });

  it('exige lectura visual verificada de una página escaneada y conserva las demás', async () => {
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => path.startsWith('/files?')
      ? Response.json({ files: [{ id: 'manual', name: 'manual.pdf', mimeType: 'application/pdf', version: '1', modifiedTime: '2026-10-28T00:00:00Z', parents: [folderId] }] })
      : new Response(Buffer.from('pdf local')));
    const image = Buffer.from('portada escaneada');
    const imageHash = createHash('sha256').update(image).digest('hex');
    const extract = vi.fn(async () => ({ sections: [{ ref: 'página 2', text: 'Contenido verificable' }], warnings: ['página 1: sin capa de texto; pendiente de verificación visual'], visionPages: [{ ref: 'página 1', image: image.toString('base64'), textLayer: '', kind: 'scanned' as const }] }));
    const loadVision = vi.fn(async (_fileId: string, _revision: string, _page: string, hash: string) => hash === imageHash ? 'Manual de obligaciones. Organigrama del proyecto.' : null);
    const report = await syncProtocolDrive(request, { maxTokens: 1000, save, extract, loadVision });
    expect(report.error).toBeNull();
    expect(report.files[0]).toMatchObject({ status: 'con avisos', sections: 2, warnings: ['página 1: transcripción visual verificada'] });
    expect(loadVision).toHaveBeenCalledWith('manual', '1', 'página 1', imageHash);
    expect(save.mock.calls[0]?.[0].files[0].sections).toEqual(expect.arrayContaining([
      { ref: 'página 1', text: 'Manual de obligaciones. Organigrama del proyecto.' },
      { ref: 'página 2', text: 'Contenido verificable' },
    ]));
    expect(save).toHaveBeenCalledOnce();
  });

  it('no publica una página escaneada si cambia la imagen o falta la transcripción', async () => {
    const save = vi.fn(async () => undefined);
    const request = vi.fn(async (path: string) => path.startsWith('/files?')
      ? Response.json({ files: [{ id: 'manual', name: 'manual.pdf', mimeType: 'application/pdf', version: '2', modifiedTime: '2026-10-28T00:00:00Z', parents: [folderId] }] })
      : new Response(Buffer.from('pdf local')));
    const extract = vi.fn(async () => ({ sections: [{ ref: 'página 2', text: 'Contenido verificable' }], warnings: ['página 1: sin capa de texto; pendiente de verificación visual'], visionPages: [{ ref: 'página 1', image: Buffer.from('imagen nueva').toString('base64'), textLayer: '', kind: 'scanned' as const }] }));
    const loadVision = vi.fn(async () => null);
    const report = await syncProtocolDrive(request, { maxTokens: 1000, save, extract, loadVision });
    expect(report.error).toContain('se conserva el corpus anterior');
    expect(report.files[0].warnings[0]).toContain('falta una transcripción visual verificada');
    expect(save).not.toHaveBeenCalled();
  });

  it('conserva el corpus anterior y reanuda desde páginas visuales ya verificadas', async () => {
    const cache = new Map<string, string>();
    const save = vi.fn(async () => undefined);
    const firstImage = Buffer.from('imagen uno');
    const secondImage = Buffer.from('imagen dos');
    const extract = vi.fn(async () => ({
      sections: [
        { ref: 'página 1', text: '| Fase | PMC |\n| viernes | 30 min |' },
        { ref: 'página 2', text: '| Fase | PMC |\n| lunes | 20 min |' },
      ],
      warnings: [],
      visionPages: [
        { ref: 'página 1', image: firstImage.toString('base64'), textLayer: 'Fase PMC viernes 30 min' },
        { ref: 'página 2', image: secondImage.toString('base64'), textLayer: 'Fase PMC lunes 20 min' },
      ],
    }));
    const request = vi.fn(async (path: string) => path.startsWith('/files?')
      ? Response.json({ files: [{ id: 'doc-1', name: 'matriz.pdf', mimeType: 'application/pdf', version: '1', modifiedTime: '2026-10-28T00:00:00Z', parents: [folderId] }] })
      : new Response(Buffer.from('pdf local')));
    const key = (page: string, hash: string) => `${page}:${hash}`;
    const loadVision = vi.fn(async (_fileId: string, _revision: string, page: string, hash: string) => cache.get(key(page, hash)) || null);
    const saveVision = vi.fn(async (_fileId: string, _revision: string, page: string, hash: string, markdown: string) => { cache.set(key(page, hash), markdown); });
    let failSecondPage = true;
    const transcribeTable = vi.fn(async (image: Buffer) => {
      if (image.equals(secondImage) && failSecondPage) throw new Error('Modelo de visión no disponible');
      return image.equals(firstImage) ? '| Fase | PMC |\n| viernes | 30 min |' : '| Fase | PMC |\n| lunes | 20 min |';
    });
    const options = { maxTokens: 1000, save, extract, loadVision, saveVision, transcribeTable };

    const failed = await syncProtocolDrive(request, options);
    expect(failed.error).toContain('se conserva el corpus anterior');
    expect(save).not.toHaveBeenCalled();
    expect(cache.get(key('página 1', createHash('sha256').update(firstImage).digest('hex')))).toBeTruthy();
    expect(cache.size).toBe(1);

    failSecondPage = false;
    const resumed = await syncProtocolDrive(request, options);
    expect(resumed.error).toBeNull();
    expect(resumed.versionId).toMatch(/^[0-9a-f]{64}$/u);
    expect(cache.size).toBe(2);
    expect(transcribeTable).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
