export type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  md5Checksum?: string;
  webViewLink?: string;
  parents?: string[];
  description?: string;
  driveId?: string;
  resourceKey?: string;
  shortcutDetails?: { targetId?: string; targetResourceKey?: string };
};

type DrivePage = { files?: GoogleDriveFile[]; nextPageToken?: string; incompleteSearch?: boolean };
type DriveRequest = (path: string, resourceKeys?: string) => Promise<Response>;
type WalkOptions = { pageSize: number; enabled: () => Promise<boolean>; onIssue: (message: string) => void };
const folderMime = 'application/vnd.google-apps.folder';
const shortcutMime = 'application/vnd.google-apps.shortcut';
const fileFields = 'id,name,mimeType,modifiedTime,createdTime,size,md5Checksum,webViewLink,parents,description,driveId,resourceKey,shortcutDetails(targetId,targetResourceKey)';

export async function* iterateGoogleDriveFolderFiles(folderId: string, request: DriveRequest, options: WalkOptions): AsyncGenerator<GoogleDriveFile> {
  const visitedFolders = new Set<string>();
  const visitedFiles = new Set<string>();
  const metadata = new Map<string, GoogleDriveFile>();
  const pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize) || 1000));

  const resolveFile = async (initial: GoogleDriveFile): Promise<GoogleDriveFile> => {
    let file = initial;
    const shortcuts = new Set<string>();
    while (file.mimeType === shortcutMime) {
      if (!await options.enabled()) throw new Error('Origen desactivado durante el recorrido');
      if (shortcuts.has(file.id)) throw new Error(`Ciclo de accesos directos: ${file.id}`);
      shortcuts.add(file.id);
      const target = file.shortcutDetails?.targetId;
      if (!target) throw new Error(`Acceso directo sin destino: ${file.id}`);
      const key = file.shortcutDetails?.targetResourceKey;
      if (!metadata.has(target)) {
        const response = await request(`/files/${encodeURIComponent(target)}?${new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' })}`, key ? `${target}/${key}` : undefined);
        const resolved = await response.json() as GoogleDriveFile;
        if (resolved.id !== target || !resolved.mimeType) throw new Error(`Metadatos de destino inválidos: ${target}`);
        metadata.set(target, { ...resolved, resourceKey: resolved.resourceKey || key });
      }
      file = metadata.get(target)!;
    }
    return file;
  };

  if (!await options.enabled()) return;
  const rootResponse = await request(`/files/${encodeURIComponent(folderId)}?${new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' })}`);
  if (!await options.enabled()) return;
  const root = await resolveFile(await rootResponse.json() as GoogleDriveFile);
  if (!root.id || root.mimeType !== folderMime) throw new Error('El origen de Drive no es una carpeta accesible');
  const pendingFolders = [root];
  for (let folderIndex = 0; folderIndex < pendingFolders.length; folderIndex += 1) {
    const folder = pendingFolders[folderIndex];
    if (visitedFolders.has(folder.id)) continue;
    visitedFolders.add(folder.id);
    let pageToken = '';
    const visitedPages = new Set<string>();
    try {
      do {
        if (!await options.enabled()) return;
        if (visitedPages.has(pageToken)) throw new Error('Drive repitió un token de paginación');
        visitedPages.add(pageToken);
        const parent = folder.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const params = new URLSearchParams({
          q: `'${parent}' in parents and trashed = false`,
          pageSize: String(pageSize),
          orderBy: 'modifiedTime desc',
          fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          corpora: folder.driveId ? 'drive' : 'user',
        });
        if (folder.driveId) params.set('driveId', folder.driveId);
        if (pageToken) params.set('pageToken', pageToken);
        const response = await request(`/files?${params}`, folder.resourceKey ? `${folder.id}/${folder.resourceKey}` : undefined);
        if (!await options.enabled()) return;
        const page = await response.json() as DrivePage;
        if (page.incompleteSearch) options.onIssue(`Drive devolvió una búsqueda incompleta en ${folder.id}`);
        for (const entry of page.files || []) {
          if (!await options.enabled()) return;
          let file: GoogleDriveFile;
          try {
            file = await resolveFile(entry);
            if (!file.id || !file.mimeType) throw new Error('Metadatos de archivo inválidos');
          } catch (error) {
            options.onIssue(`Archivo ${entry.id}: ${(error as Error).message}`);
            continue;
          }
          if (file.mimeType === folderMime) pendingFolders.push(file);
          else if (!visitedFiles.has(file.id)) {
            visitedFiles.add(file.id);
            yield file;
          }
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    } catch (error) {
      options.onIssue(`Carpeta ${folder.id}: ${(error as Error).message}`);
    }
  }
}
