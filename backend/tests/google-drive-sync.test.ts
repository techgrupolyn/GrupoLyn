import { describe, expect, it, vi } from 'vitest';
import { iterateGoogleDriveFolderFiles, type GoogleDriveFile } from '../google-drive-sync.ts';

const folder = (id: string): GoogleDriveFile => ({ id, name: id, mimeType: 'application/vnd.google-apps.folder' });
const document = (id: string): GoogleDriveFile => ({ id, name: id, mimeType: 'application/vnd.google-apps.document' });
const shortcut = (id: string, targetId: string): GoogleDriveFile => ({ id, name: id, mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId } });
const json = (body: unknown) => new Response(JSON.stringify(body));
const collect = async (request: (path: string, keys?: string) => Promise<Response>, onIssue = vi.fn(), enabled = async () => true) => {
  const files: GoogleDriveFile[] = [];
  for await (const file of iterateGoogleDriveFolderFiles('root', request, { pageSize: 1000, enabled, onIssue })) files.push(file);
  return files;
};

describe('Recorrido completo de Google Drive', () => {
  it('recorre más de 1000 archivos, páginas vacías y subcarpetas sin truncar', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: Array.from({ length: 1000 }, (_, index) => document(`file-${index}`)), nextPageToken: 'second' }))
      .mockResolvedValueOnce(json({ files: [], nextPageToken: 'third' }))
      .mockResolvedValueOnce(json({ files: [folder('nested'), document('new-september')] }))
      .mockResolvedValueOnce(json({ files: [document('nested-september')] }));
    const files = await collect(request);
    expect(files).toHaveLength(1002);
    expect(files.at(-1)?.id).toBe('nested-september');
    expect(new URL(request.mock.calls[2][0], 'https://drive.test').searchParams.get('pageToken')).toBe('second');
    expect(new URL(request.mock.calls[1][0], 'https://drive.test').searchParams.get('orderBy')).toBe('modifiedTime desc');
  });

  it('resuelve accesos directos a carpetas y documentos, evita ciclos y duplicados', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [shortcut('link-folder', 'nested'), shortcut('link-doc', 'doc'), document('doc')] }))
      .mockResolvedValueOnce(json(folder('nested')))
      .mockResolvedValueOnce(json(document('doc')))
      .mockResolvedValueOnce(json({ files: [folder('root'), shortcut('link-again', 'doc'), document('nested-doc')] }));
    expect((await collect(request)).map((file) => file.id)).toEqual(['doc', 'nested-doc']);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('consulta explícitamente la unidad compartida y transmite resource keys', async () => {
    const request = vi.fn().mockResolvedValueOnce(json({ ...folder('root'), driveId: 'shared-drive', resourceKey: 'root-key' }))
      .mockResolvedValueOnce(json({ files: [{ ...shortcut('link', 'doc'), shortcutDetails: { targetId: 'doc', targetResourceKey: 'doc-key' } }] }))
      .mockResolvedValueOnce(json(document('doc')));
    expect((await collect(request))[0].resourceKey).toBe('doc-key');
    const params = new URL(request.mock.calls[1][0], 'https://drive.test').searchParams;
    expect(params.get('corpora')).toBe('drive');
    expect(params.get('driveId')).toBe('shared-drive');
    expect(request.mock.calls[1][1]).toBe('root/root-key');
    expect(request.mock.calls[2][1]).toBe('doc/doc-key');
  });

  it('señala búsqueda incompleta sin perder los archivos que sí puede importar', async () => {
    const onIssue = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [document('available')], incompleteSearch: true }));
    expect(await collect(request, onIssue)).toHaveLength(1);
    expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('búsqueda incompleta'));
  });

  it('un destino inaccesible no bloquea documentos ni subcarpetas restantes', async () => {
    const onIssue = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [shortcut('broken', 'denied'), document('available'), folder('nested')] }))
      .mockRejectedValueOnce(new Error('Google Drive respondió 403'))
      .mockResolvedValueOnce(json({ files: [document('nested-doc')] }));
    expect((await collect(request, onIssue)).map((file) => file.id)).toEqual(['available', 'nested-doc']);
    expect(onIssue).toHaveBeenCalledTimes(1);
  });

  it('no entra en bucle cuando Drive repite un token de paginación', async () => {
    const onIssue = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [], nextPageToken: 'same' }))
      .mockResolvedValueOnce(json({ files: [], nextPageToken: 'same' }));
    await collect(request, onIssue);
    expect(request).toHaveBeenCalledTimes(3);
    expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('token de paginación'));
  });

  it('detiene la lectura si se desactiva el origen durante una llamada', async () => {
    let active = true;
    const request = vi.fn().mockResolvedValueOnce(json(folder('root'))).mockImplementationOnce(async () => {
      active = false;
      return json({ files: [document('not-imported')], nextPageToken: 'unused' });
    });
    expect(await collect(request, vi.fn(), async () => active)).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('importa la primera página antes de solicitar la siguiente', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [document('first')], nextPageToken: 'next' }))
      .mockResolvedValueOnce(json({ files: [document('second')] }));
    const iterator = iterateGoogleDriveFolderFiles('root', request, { pageSize: 1000, enabled: async () => true, onIssue: vi.fn() });
    expect((await iterator.next()).value?.id).toBe('first');
    expect(request).toHaveBeenCalledTimes(2);
    expect((await iterator.next()).value?.id).toBe('second');
    await iterator.return();
  });

  it('admite una carpeta registrada que es un acceso directo', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(shortcut('root', 'actual-folder')))
      .mockResolvedValueOnce(json(folder('actual-folder')))
      .mockResolvedValueOnce(json({ files: [document('september')] }));
    expect((await collect(request)).map((file) => file.id)).toEqual(['september']);
    expect(new URL(request.mock.calls[2][0], 'https://drive.test').searchParams.get('q')).toContain("'actual-folder' in parents");
  });

  it('un ciclo entre accesos directos no bloquea otros documentos', async () => {
    const onIssue = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [shortcut('cycle-a', 'cycle-b'), document('available')] }))
      .mockResolvedValueOnce(json(shortcut('cycle-b', 'cycle-a')))
      .mockResolvedValueOnce(json(shortcut('cycle-a', 'cycle-b')));
    expect((await collect(request, onIssue)).map((file) => file.id)).toEqual(['available']);
    expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('Ciclo de accesos directos'));
  });

  it('un error al listar una subcarpeta no oculta la carpeta siguiente', async () => {
    const onIssue = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(json(folder('root')))
      .mockResolvedValueOnce(json({ files: [folder('denied'), folder('allowed')] }))
      .mockRejectedValueOnce(new Error('Google Drive respondió 404'))
      .mockResolvedValueOnce(json({ files: [document('available')] }));
    expect((await collect(request, onIssue)).map((file) => file.id)).toEqual(['available']);
    expect(onIssue).toHaveBeenCalledWith(expect.stringContaining('404'));
  });
});
