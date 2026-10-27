import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMeetingRecordingService, ensureMeetingRecordingSchema } from '../meeting-recordings.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Grabaciones en PostgreSQL QA local', () => {
  let client: Client;
  const drive = vi.fn();
  const token = vi.fn().mockResolvedValue('test-token');
  const events = vi.fn().mockResolvedValue([]);
  let service: ReturnType<typeof createMeetingRecordingService>;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.port !== '15439' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE TEMP TABLE google_drive_connections(id TEXT PRIMARY KEY,scope TEXT,revoked_at TIMESTAMPTZ);
      CREATE TEMP TABLE google_drive_folders(id TEXT PRIMARY KEY,enabled BOOLEAN);
      CREATE TEMP TABLE google_drive_artifacts(id TEXT PRIMARY KEY,google_file_id TEXT,name TEXT,connection_id TEXT,folder_id TEXT,artifact_type TEXT,mime_type TEXT);
      CREATE TEMP TABLE meeting_reviews(artifact_id TEXT PRIMARY KEY,meeting_date DATE);
      INSERT INTO google_drive_connections VALUES('connection','/auth/calendar.events.readonly',NULL),('other','',NULL);
      INSERT INTO google_drive_folders VALUES('folder',TRUE);
      INSERT INTO google_drive_artifacts VALUES('notes','notes123456','Dana (2026-10-19 08:30 GMT-04:00) – Notas de Gemini','connection','folder','notes','text/plain');
      INSERT INTO meeting_reviews VALUES('notes','2026-10-19');`);
    await ensureMeetingRecordingSchema(client);
    await ensureMeetingRecordingSchema(client);
    service = createMeetingRecordingService(client, { token, drive, events });
  });
  afterAll(async () => { if (client) await client.end(); });
  it('migra de forma idempotente y deja los existentes en pending', async () => {
    expect((await client.query('SELECT recording_file_id,recording_status FROM meeting_reviews')).rows[0]).toEqual({ recording_file_id: null, recording_status: 'pending' });
    await expect(client.query("UPDATE meeting_reviews SET recording_status='invalid'")).rejects.toThrow();
    await expect(client.query("UPDATE meeting_reviews SET recording_status='available'")).rejects.toThrow();
  });
  it('ausencia devuelve none sin usar vídeos de otra conexión', async () => {
    drive.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'notes123456', parents: [] })));
    await client.query("INSERT INTO google_drive_artifacts VALUES('foreign','foreign123456','Dana (2026-10-19 08:30 GMT-04:00) – Recording.mp4','other','folder','recording','video/mp4')");
    await service.refresh('notes');
    expect((await client.query('SELECT recording_status FROM meeting_reviews')).rows[0].recording_status).toBe('none');
    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive.mock.calls[0][0]).toContain('/files/notes123456?');
    drive.mockClear();
    expect(token).toHaveBeenCalledWith('connection');
  });
  it('respeta la espera de reintento y recupera un vídeo que aparece más tarde', async () => {
    token.mockClear();
    await service.refresh('notes');
    expect(token).not.toHaveBeenCalled();
    await client.query("INSERT INTO google_drive_artifacts VALUES('video','video123456','Dana (2026-10-19 08:30 GMT-04:00) – Recording.mp4','connection','folder','recording','video/mp4'); UPDATE meeting_reviews SET recording_checked_at=NOW()-INTERVAL '6 minutes'");
    drive.mockResolvedValue(new Response(JSON.stringify({ id: 'video123456', mimeType: 'video/mp4', name: 'Vídeo' })));
    await service.refresh('notes');
    expect((await client.query('SELECT recording_file_id,recording_status FROM meeting_reviews')).rows[0]).toEqual({ recording_file_id: 'video123456', recording_status: 'available' });
    expect(drive).toHaveBeenCalledTimes(1);
    await service.refresh('notes');
    expect(drive).toHaveBeenCalledTimes(1);
  });
  it('404 y 403 quedan pendientes sin romper el informe ni modificar permisos', async () => {
    await client.query("UPDATE meeting_reviews SET recording_file_id=NULL,recording_status='pending',recording_checked_at=NULL");
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const code of [403, 404]) {
        await client.query('UPDATE meeting_reviews SET recording_checked_at=NULL');
        drive.mockRejectedValueOnce(new Error(`HTTP ${code}`));
        await service.refresh('notes');
        expect((await client.query('SELECT recording_status FROM meeting_reviews')).rows[0].recording_status).toBe('pending');
      }
      expect(drive.mock.calls.every(([path]) => path.startsWith('/files/') && !path.includes('permissions') && !path.includes('alt=media'))).toBe(true);
    } finally { warning.mockRestore(); }
  });
  it('guarda el enlace explícito del documento aunque difieran los títulos de notas y vídeo', async () => {
    await client.query("UPDATE meeting_reviews SET recording_file_id=NULL,recording_status='pending',recording_checked_at=NULL; UPDATE google_drive_artifacts SET mime_type='application/vnd.google-apps.document',name='Reunión iniciada a las 2026/10/19 08:30 GMT-04:00 - Notas de Gemini' WHERE id='notes'");
    events.mockClear();
    drive.mockImplementation(async (path: string) => path.includes('/export?')
      ? new Response('<a href="https://www.google.com/url?q=https://drive.google.com/file/d/video123456/view&amp;sa=D">Grabaci&oacute;n</a>')
      : new Response(JSON.stringify({ id: 'video123456', name: 'meet-code (2026-10-19 08:30 GMT-4)', mimeType: 'video/mp4' })));
    await service.refresh('notes');
    expect((await client.query('SELECT recording_file_id,recording_status FROM meeting_reviews')).rows[0]).toEqual({ recording_file_id: 'video123456', recording_status: 'available' });
    expect(events).not.toHaveBeenCalled();
  });
  it('no consulta orígenes pausados ni revocados', async () => {
    token.mockClear();
    await client.query("UPDATE meeting_reviews SET recording_file_id=NULL,recording_status='pending',recording_checked_at=NULL; UPDATE google_drive_folders SET enabled=FALSE");
    await service.refresh('notes');
    await client.query("UPDATE google_drive_folders SET enabled=TRUE; UPDATE google_drive_connections SET revoked_at=NOW()");
    await service.refresh('notes');
    expect(token).not.toHaveBeenCalled();
  });
});
