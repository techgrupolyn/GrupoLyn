import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { calendarEventsForDate, type CalendarMeeting } from './meeting-organizer.ts';

export type RecordingState = { recording_file_id: string | null; recording_status: 'pending' | 'available' | 'none' };
type RecordingSource = { id: string; google_file_id: string; name: string; connection_id: string; scope: string; meeting_date: string | null; mime_type?: string };
type RecordingFile = { id: string; name: string; mimeType: string; trashed?: boolean; parents?: string[] };
export type RecordingAccess = { schedule: (artifactId: string) => void };
const validFileId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{10,255}$/.test(value);

export function recordingState(row: Partial<RecordingState>): RecordingState {
  if (row.recording_status === 'available' && validFileId(row.recording_file_id)) return { recording_status: 'available', recording_file_id: row.recording_file_id };
  return { recording_status: row.recording_status === 'none' ? 'none' : 'pending', recording_file_id: null };
}

export async function ensureMeetingRecordingSchema(pool: Pick<Pool, 'query'>) {
  await pool.query(await readFile(new URL('./migrations/20261019_meeting_recordings.sql', import.meta.url), 'utf8'));
}

export function recordingNameKey(name: string): string | null {
  const key = name.normalize('NFC').trim().replace(/\.(mp4|webm|mov|mkv|txt|vtt|srt)$/i, '')
    .replace(/^transcripci[oó]n del chat:\s*/i, '')
    .replace(/\b(\d{4})\/(\d{2})\/(\d{2})\b/g, '$1-$2-$3')
    .replace(/\s*[-–—]?\s*(recording|grabación|notas de gemini|notes by gemini|transcript|transcripción)$/i, '').trim().toLowerCase();
  return /\b\d{4}-\d{2}-\d{2}[ t]\d{2}[:._]\d{2}\b/.test(key) ? key : null;
}

export async function recordingFilesInSourceFolders(sourceId: string, drive: (path: string) => Promise<Response>): Promise<RecordingFile[]> {
  const metadataParams = new URLSearchParams({ fields: 'id,name,mimeType,parents,trashed', supportsAllDrives: 'true' });
  const source = await (await drive(`/files/${encodeURIComponent(sourceId)}?${metadataParams}`)).json() as RecordingFile;
  if (source.id !== sourceId || source.trashed) throw new Error('Origen de grabación no válido');
  const files = new Map<string, RecordingFile>();
  for (const parent of new Set(source.parents || [])) {
    if (!validFileId(parent)) throw new Error('Carpeta de grabación no válida');
    let pageToken = '';
    const visited = new Set<string>();
    do {
      const params = new URLSearchParams({ q: `'${parent}' in parents and trashed = false and mimeType contains 'video/'`, fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,trashed,parents)', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await (await drive(`/files?${params}`)).json() as { files?: RecordingFile[]; nextPageToken?: string; incompleteSearch?: boolean };
      if (page.incompleteSearch || !Array.isArray(page.files)) throw new Error('Búsqueda de grabaciones incompleta');
      for (const file of page.files) {
        if (validFileId(file.id) && file.mimeType?.startsWith('video/') && !file.trashed && file.parents?.includes(parent)) files.set(file.id, file);
      }
      pageToken = page.nextPageToken || '';
      if (pageToken && visited.has(pageToken)) throw new Error('Paginación de grabaciones repetida');
      visited.add(pageToken);
    } while (pageToken);
  }
  return [...files.values()];
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function recordingIdsFromNotesHtml(html: string): string[] {
  const identifiers = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = decodeHtml(match[2].replace(/<[^>]*>/g, '')).trim();
    if (!/^(?:🎥|🎬|📹)?\s*(?:grabación|recording)$/iu.test(label)) continue;
    const href = match[1].match(/(?:^|\s)href\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try {
      let url = new URL(decodeHtml(href));
      if (url.protocol === 'https:' && url.hostname === 'www.google.com' && url.pathname === '/url') url = new URL(url.searchParams.get('q') || '');
      if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) continue;
      const fileId = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,255})(?:\/view)?\/?$/)?.[1];
      if (fileId) identifiers.add(fileId);
    } catch { continue; }
  }
  return [...identifiers];
}

export async function resolveMeetingRecording(source: RecordingSource, files: RecordingFile[], events: CalendarMeeting[], getFile: (id: string) => Promise<RecordingFile>, explicitIds: string[] = []): Promise<RecordingState> {
  const matchedEvents = events.filter(event => event.status !== 'cancelled' && event.attachments?.some(attachment => attachment.fileId === source.google_file_id));
  if (matchedEvents.length > 1) return { recording_status: 'pending', recording_file_id: null };
  const identifiers = new Set<string>(explicitIds.filter(validFileId));
  const key = recordingNameKey(source.name);
  for (const file of files) if (key && file.mimeType.startsWith('video/') && recordingNameKey(file.name) === key && validFileId(file.id)) identifiers.add(file.id);
  for (const attachment of matchedEvents[0]?.attachments || []) {
    if (attachment.mimeType?.startsWith('video/') && validFileId(attachment.fileId)) identifiers.add(attachment.fileId);
  }
  if (identifiers.size > 1) return { recording_status: 'pending', recording_file_id: null };
  if (!identifiers.size) return { recording_status: 'none', recording_file_id: null };
  const fileId = [...identifiers][0];
  const file = await getFile(fileId);
  if (file.id !== fileId || !file.mimeType.startsWith('video/') || file.trashed) return { recording_status: 'pending', recording_file_id: null };
  return { recording_status: 'available', recording_file_id: fileId };
}

export function createMeetingRecordingService(pool: Pick<Pool, 'query'>, dependencies: {
  token: (connectionId: string) => Promise<string>;
  drive: (path: string, token: string) => Promise<Response>;
  events?: typeof calendarEventsForDate;
  changed?: (artifactId: string) => void;
}) {
  const running = new Map<string, Promise<void>>();
  async function refresh(artifactId: string): Promise<void> {
    const claim = await pool.query(`UPDATE meeting_reviews review SET recording_checked_at=NOW()
      FROM google_drive_artifacts artifact,google_drive_folders folder,google_drive_connections connection
      WHERE review.artifact_id=$1 AND artifact.id=review.artifact_id AND folder.id=artifact.folder_id
        AND folder.enabled=TRUE AND connection.id=artifact.connection_id AND connection.revoked_at IS NULL
        AND review.recording_status<>'available'
        AND (review.recording_checked_at IS NULL OR review.recording_checked_at<NOW()-INTERVAL '5 minutes')
      RETURNING artifact.id,artifact.google_file_id,artifact.name,artifact.connection_id,artifact.mime_type,connection.scope,review.meeting_date::text`, [artifactId]);
    const source = claim.rows[0] as RecordingSource | undefined;
    if (!source) return;
    try {
      const token = await dependencies.token(source.connection_id);
      const videos = await pool.query(`SELECT google_file_id AS id,name,mime_type AS "mimeType" FROM google_drive_artifacts WHERE connection_id=$1 AND artifact_type='recording'`, [source.connection_id]);
      const explicitIds = source.mime_type === 'application/vnd.google-apps.document'
        ? recordingIdsFromNotesHtml(await (await dependencies.drive(`/files/${encodeURIComponent(source.google_file_id)}/export?mimeType=text%2Fhtml`, token)).text()) : [];
      const events = !explicitIds.length && source.meeting_date && String(source.scope || '').includes('/auth/calendar')
        ? await (dependencies.events || calendarEventsForDate)(token, source.meeting_date) : [];
      const getFile = async (fileId: string) => {
        const params = new URLSearchParams({ fields: 'id,name,mimeType,trashed', supportsAllDrives: 'true' });
        return (await dependencies.drive(`/files/${encodeURIComponent(fileId)}?${params}`, token)).json() as Promise<RecordingFile>;
      };
      let state = await resolveMeetingRecording(source, videos.rows, events, getFile, explicitIds);
      if (state.recording_status === 'none') {
        const siblings = await recordingFilesInSourceFolders(source.google_file_id, path => dependencies.drive(path, token));
        state = await resolveMeetingRecording(source, siblings, events, getFile, explicitIds);
      }
      await pool.query(`UPDATE meeting_reviews review SET recording_file_id=$2,recording_status=$3::meeting_recording_status
        WHERE artifact_id=$1 AND recording_status<>'available'
          AND EXISTS (SELECT 1 FROM google_drive_artifacts artifact JOIN google_drive_folders folder ON folder.id=artifact.folder_id
            JOIN google_drive_connections connection ON connection.id=artifact.connection_id
            WHERE artifact.id=$1 AND folder.enabled=TRUE AND connection.revoked_at IS NULL)`, [artifactId, state.recording_file_id, state.recording_status]);
      dependencies.changed?.(artifactId);
    } catch {
      await pool.query("UPDATE meeting_reviews SET recording_status='pending',recording_file_id=NULL WHERE artifact_id=$1 AND recording_status<>'available'", [artifactId]);
      console.warn('[meeting-recording] No se pudo comprobar la grabación', artifactId);
    }
  }
  function schedule(artifactId: string) {
    if (running.has(artifactId) || running.size >= 3) return;
    const job = refresh(artifactId).catch(() => console.warn('[meeting-recording] Comprobación pendiente', artifactId)).finally(() => running.delete(artifactId));
    running.set(artifactId, job);
  }
  return { schedule, refresh };
}
