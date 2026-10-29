import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { syncProtocolDrive } from '../protocol-drive.ts';

const folderId = '14oB0TKbGyvEDMti2JgjXIep54-ZcMbc_';

describe('sincronización de protocolos', () => {
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
