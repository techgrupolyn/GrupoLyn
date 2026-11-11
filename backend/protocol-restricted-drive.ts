import type { ProtocolFile } from './protocol-corpus.ts';
import { extractFile, extractionFormat } from './protocol-drive.ts';

type DriveEntry = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  version?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  resourceKey?: string;
};
type DriveRequest = (path: string, resourceKeys?: string) => Promise<Response>;

export async function syncRestrictedProtocolDrive(request: DriveRequest, options: {
  folderId: string;
  generalFiles: ProtocolFile[];
  previousFiles: ProtocolFile[];
  save: (files: ProtocolFile[]) => Promise<void>;
  pythonBin?: string;
  extract?: typeof extractFile;
}): Promise<{ fileCount: number; error: string | null }> {
  try {
    if (!/^[\w-]+$/u.test(options.folderId)) throw new Error('Carpeta privada no válida');
    const folders = [options.folderId];
    const visited = new Set<string>();
    const entries: DriveEntry[] = [];
    const generalNames = new Set(options.generalFiles.map(file => file.name.trim().normalize('NFKC').toLocaleLowerCase('es')));
    const ids = new Set(options.generalFiles.map(file => file.id));
    for (const folder of folders) {
      if (visited.has(folder)) continue;
      visited.add(folder);
      let pageToken = '';
      const pageTokens = new Set<string>();
      do {
        if (pageTokens.has(pageToken)) throw new Error('Drive repitió la paginación');
        pageTokens.add(pageToken);
        const params = new URLSearchParams({
          q: `'${folder}' in parents and trashed = false`, pageSize: '1000',
          fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,version,modifiedTime,md5Checksum,resourceKey)',
          supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await request(`/files?${params}`);
        if (!response.ok) throw new Error(`Google Drive respondió ${response.status}`);
        const page = await response.json() as { files?: DriveEntry[]; nextPageToken?: string; incompleteSearch?: boolean };
        if (page.incompleteSearch) throw new Error('Google Drive devolvió una búsqueda incompleta');
        for (const entry of page.files || []) {
          if (!entry.parents?.includes(folder)) continue;
          if (entry.mimeType === 'application/vnd.google-apps.folder') {
            if (!/^_obsoletos$/iu.test(entry.name.trim())) folders.push(entry.id);
            continue;
          }
          if (ids.has(entry.id) || generalNames.has(entry.name.trim().normalize('NFKC').toLocaleLowerCase('es'))) continue;
          if (entries.some(existing => existing.id === entry.id)) continue;
          entries.push(entry);
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    }
    if (!entries.length) throw new Error('No se encontraron documentos privados verificables');
    const files: ProtocolFile[] = [];
    for (const entry of entries) {
      const format = extractionFormat(entry);
      if (!format) throw new Error('Hay un formato privado no soportado');
      const revision = entry.version || entry.md5Checksum || entry.modifiedTime;
      if (!revision) throw new Error('Documento privado sin revisión verificable');
      const previous = options.previousFiles.find(file => file.id === entry.id && file.revision === revision && file.name === entry.name && file.extractionVersion === 4);
      if (previous) {
        files.push({ ...previous, audience: 'restricted' });
        continue;
      }
      const path = format.exportMime
        ? `/files/${encodeURIComponent(entry.id)}/export?mimeType=${encodeURIComponent(format.exportMime)}`
        : `/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`;
      const response = await request(path, entry.resourceKey ? `${entry.id}/${entry.resourceKey}` : undefined);
      if (!response.ok) throw new Error(`Google Drive respondió ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 30 * 1024 * 1024) throw new Error('Documento privado demasiado grande');
      const extracted = await (options.extract || extractFile)(format.kind, bytes, options.pythonBin || process.env.PROTOCOL_PYTHON_BIN || 'python3', 5000);
      if (!extracted.sections.length || extracted.visionPages?.length || extracted.warnings.some(warning => /sin capa de texto|omitid|no verificad|límite de \d+ filas/iu.test(warning))) {
        throw new Error('Documento privado incompleto o pendiente de verificación visual');
      }
      files.push({
        id: entry.id, name: entry.name, mimeType: entry.mimeType, audience: 'restricted',
        modifiedTime: entry.modifiedTime || '', revision, extractionVersion: 4,
        sections: extracted.sections, warnings: extracted.warnings,
      });
    }
    const sameFiles = files.length === options.previousFiles.length && files.every(file =>
      options.previousFiles.some(previous => previous.id === file.id && previous.revision === file.revision && previous.name === file.name && previous.extractionVersion === file.extractionVersion));
    if (!sameFiles) await options.save(files);
    return { fileCount: files.length, error: null };
  } catch (error) {
    return { fileCount: 0, error: (error as Error).message };
  }
}
