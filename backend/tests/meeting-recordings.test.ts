import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createMeetingRecordingService, recordingFilesInSourceFolders, recordingIdsFromNotesHtml, recordingNameKey, recordingState, resolveMeetingRecording } from '../meeting-recordings.ts';

const source = { id: 'meeting', google_file_id: 'notes123456', name: 'Obra Dana (2026-10-19 08:30 GMT-04:00) – Notas de Gemini', connection_id: 'connection', scope: '/auth/calendar.events.readonly', meeting_date: '2026-10-19' };
const video = { id: 'video123456', name: 'Obra Dana (2026-10-19 08:30 GMT-04:00) – Recording.mp4', mimeType: 'video/mp4' };
const event = { id: 'event', attachments: [{ fileId: source.google_file_id }, { fileId: video.id, mimeType: video.mimeType }] };

describe('Grabaciones de reuniones', () => {
  it('reconoce fechas con barras y transcripciones del chat sin perder la identidad de la reunión', () => {
    expect(recordingNameKey('FASE 0/2 PROYECTO ANDREA - ORIHUELA - 2026/05/12 10:17 CEST - Recording')).toBe(recordingNameKey('FASE 0/2 PROYECTO ANDREA - ORIHUELA - 2026-05-12 10:17 CEST - Recording.mp4'));
    expect(recordingNameKey('Transcripción del chat: ssn-akca-dcj (2026-07-10 18:24 GMT+2)')).toBe(recordingNameKey('ssn-akca-dcj (2026-07-10 18:24 GMT+2)'));
    expect(recordingNameKey('Transcripción del chat: ssn-akca-dcj (2026-07-10 18:24 GMT+2)')).not.toBe(recordingNameKey('ssn-akca-dcj (2026-07-11 18:24 GMT+2)'));
  });
  it('consulta todas las páginas de las carpetas reales y excluye archivos ajenos o borrados', async () => {
    const parent = 'folder123456';
    const drive = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: source.google_file_id, parents: [parent] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ ...video, parents: [parent] }, { ...video, id: 'outside12345', parents: ['another12345'] }], nextPageToken: 'second' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ ...video, id: 'deleted12345', parents: [parent], trashed: true }] })));
    expect(await recordingFilesInSourceFolders(source.google_file_id, drive)).toEqual([{ ...video, parents: [parent] }]);
    expect(new URL('https://example.test' + drive.mock.calls[2][0]).searchParams.get('pageToken')).toBe('second');
    expect(drive.mock.calls.every(([path]) => !path.includes('permissions') && !path.includes('alt=media'))).toBe(true);
  });
  it('una búsqueda incompleta o inaccesible no equivale a ausencia de vídeo', async () => {
    const drive = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: source.google_file_id, parents: ['folder123456'] }))).mockResolvedValueOnce(new Response(JSON.stringify({ incompleteSearch: true, files: [] })));
    await expect(recordingFilesInSourceFolders(source.google_file_id, drive)).rejects.toThrow('incompleta');
    await expect(recordingFilesInSourceFolders(source.google_file_id, vi.fn().mockRejectedValue(new Error('403')))).rejects.toThrow('403');
  });
  it('no entra en un bucle cuando Drive repite la página', async () => {
    const drive = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: source.google_file_id, parents: ['folder123456'] }))).mockImplementation(async () => new Response(JSON.stringify({ files: [], nextPageToken: 'repeated' })));
    await expect(recordingFilesInSourceFolders(source.google_file_id, drive)).rejects.toThrow('repetida');
    expect(drive).toHaveBeenCalledTimes(3);
  });
  it('dos vídeos con el mismo nombre y hora siguen siendo ambiguos aunque compartan carpeta', async () => {
    const name = 'Proyecto ejemplo - 2026/05/12 10:17 CEST - Recording';
    const get = vi.fn();
    expect(await resolveMeetingRecording({ ...source, name }, [{ ...video, name }, { ...video, id: 'second123456', name }], [], get)).toEqual({ recording_status: 'pending', recording_file_id: null });
    expect(get).not.toHaveBeenCalled();
  });
  it('no asigna el único vídeo de una carpeta si pertenece a otra reunión', async () => {
    expect(await resolveMeetingRecording(source, [{ ...video, name: 'Otra obra (2026-10-19 08:30 GMT-04:00) – Recording' }], [], vi.fn())).toEqual({ recording_status: 'none', recording_file_id: null });
  });
  it('encuentra un vídeo no importado mediante la carpeta de la transcripción', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => sql.startsWith('UPDATE meeting_reviews review SET recording_checked_at') ? { rows: [source] } : { rows: [] });
    const drive = vi.fn().mockImplementation(async (path: string) => new Response(JSON.stringify(path.startsWith('/files?') ? { files: [{ ...video, parents: ['folder123456'] }] } : path.startsWith('/files/notes') ? { id: source.google_file_id, parents: ['folder123456'] } : video)));
    await createMeetingRecordingService({ query } as unknown as Pool, { token: async () => 'token', drive, events: async () => [] }).refresh(source.id);
    expect(query.mock.calls.at(-1)?.[1]).toEqual([source.id, video.id, 'available']);
  });
  it('extrae el enlace explícito de Gemini aunque el título del vídeo sea distinto', async () => {
    const html = '<a href="https://www.google.com/url?q=https://drive.google.com/file/d/video123456/view?usp%3Ddrive_web&amp;sa=D">Grabaci&oacute;n</a>';
    const identifiers = recordingIdsFromNotesHtml(html);
    expect(identifiers).toEqual([video.id]);
    expect(await resolveMeetingRecording({ ...source, name: 'Reunión iniciada a las 2026/10/19 08:30 GMT-04:00 - Notas de Gemini' }, [], [], async () => video, identifiers)).toEqual({ recording_status: 'available', recording_file_id: video.id });
  });
  it('acepta etiquetas de grabación con spans y entidades sin ejecutar el HTML', () => {
    expect(recordingIdsFromNotesHtml('<a href="https://drive.google.com/file/d/video123456/view"><span>🎥 Grabaci&#243;n</span></a><a href="https://drive.google.com/file/d/video123456/view">Recording</a>')).toEqual([video.id]);
  });
  it('rechaza referencias sin etiqueta, dominios engañosos y esquemas inseguros', () => {
    for (const href of ['javascript:alert(1)', 'https://drive.google.com.evil.test/file/d/video123456/view', 'https://drive.google.com@evil.test/file/d/video123456/view', 'http://drive.google.com/file/d/video123456/view', 'https://www.google.com/url?q=https%3A%2F%2Fevil.test%2Fvideo123456']) {
      expect(recordingIdsFromNotesHtml(`<a href="${href}">Grabación</a>`)).toEqual([]);
    }
    expect(recordingIdsFromNotesHtml('<a href="https://drive.google.com/file/d/video123456/view">Vídeo de otra obra</a>')).toEqual([]);
  });
  it('no elige arbitrariamente si las notas tienen dos enlaces de grabación', async () => {
    const identifiers = recordingIdsFromNotesHtml('<a href="https://drive.google.com/file/d/video123456/view">Grabación</a><a href="https://drive.google.com/file/d/other123456/view">Grabación</a>');
    const get = vi.fn();
    expect((await resolveMeetingRecording(source, [], [], get, identifiers)).recording_status).toBe('pending');
    expect(get).not.toHaveBeenCalled();
  });
  it('comprueba las notas con Drive antes de recurrir a Calendar y no conserva su HTML', async () => {
    const document = { ...source, mime_type: 'application/vnd.google-apps.document' };
    const query = vi.fn().mockImplementation(async (sql: string) => sql.startsWith('UPDATE meeting_reviews review SET recording_checked_at') ? { rows: [document] } : { rows: [] });
    const drive = vi.fn().mockResolvedValueOnce(new Response('<a href="https://drive.google.com/file/d/video123456/view">Recording</a>')).mockResolvedValueOnce(new Response(JSON.stringify(video)));
    const events = vi.fn();
    await createMeetingRecordingService({ query } as unknown as Pool, { token: async () => 'token', drive, events }).refresh(source.id);
    expect(events).not.toHaveBeenCalled();
    expect(drive.mock.calls[0][0]).toBe('/files/notes123456/export?mimeType=text%2Fhtml');
    expect(query.mock.calls.at(-1)?.[1]).toEqual([source.id, video.id, 'available']);
    expect(drive.mock.calls.every(([path]) => !path.includes('permissions') && !path.includes('alt=media'))).toBe(true);
  });
  it('enlaza por el archivo de notas adjunto al evento y verifica vídeo en Drive', async () => {
    const get = vi.fn().mockResolvedValue(video);
    expect(await resolveMeetingRecording(source, [], [event], get)).toEqual({ recording_status: 'available', recording_file_id: video.id });
    expect(get).toHaveBeenCalledWith(video.id);
  });
  it('enlaza el nombre exacto con fecha y hora sin depender de la carpeta', async () => {
    expect(recordingNameKey(source.name)).toBe(recordingNameKey(video.name));
    expect(await resolveMeetingRecording(source, [video], [], async () => video)).toEqual({ recording_status: 'available', recording_file_id: video.id });
  });
  it('no compara por obra o nombre similar sin fecha y hora', async () => {
    expect(recordingNameKey('Obra Dana - Notas de Gemini')).toBeNull();
    const get = vi.fn();
    expect(await resolveMeetingRecording(source, [{ ...video, name: 'Obra Dana (2026-10-20 08:30 GMT-04:00) – Recording.mp4' }], [], get)).toEqual({ recording_status: 'none', recording_file_id: null });
    expect(get).not.toHaveBeenCalled();
  });
  it('no usa códigos Meet recurrentes ni eventos de otra reunión para adivinar', async () => {
    const get = vi.fn();
    expect(await resolveMeetingRecording(source, [], [{ ...event, attachments: [{ fileId: 'othernotes1' }, event.attachments[1]] }], get)).toEqual({ recording_status: 'none', recording_file_id: null });
    expect(get).not.toHaveBeenCalled();
  });
  it('mantiene pendiente ante varios vídeos o eventos posibles', async () => {
    const get = vi.fn();
    expect((await resolveMeetingRecording(source, [video, { ...video, id: 'video987654' }], [], get)).recording_status).toBe('pending');
    expect((await resolveMeetingRecording(source, [], [event, { ...event, id: 'other' }], get)).recording_status).toBe('pending');
    expect(get).not.toHaveBeenCalled();
  });
  it('no enlaza archivos borrados, IDs distintos ni documentos que no son vídeo', async () => {
    for (const file of [{ ...video, trashed: true }, { ...video, id: 'different11' }, { ...video, mimeType: 'text/plain' }]) {
      expect((await resolveMeetingRecording(source, [video], [], async () => file)).recording_status).toBe('pending');
    }
  });
  it('una consulta vacía no es permanente y un 403 no significa sin grabación', async () => {
    expect((await resolveMeetingRecording(source, [], [], vi.fn())).recording_status).toBe('none');
    expect((await resolveMeetingRecording(source, [], [event], async () => video)).recording_status).toBe('available');
    await expect(resolveMeetingRecording(source, [video], [], async () => { throw new Error('403'); })).rejects.toThrow('403');
  });
  it('no publica IDs malformados o estados incoherentes', () => {
    expect(recordingState({ recording_status: 'available', recording_file_id: 'https://evil.test' })).toEqual({ recording_status: 'pending', recording_file_id: null });
    expect(recordingState({ recording_status: 'none', recording_file_id: video.id }).recording_file_id).toBeNull();
  });
  it('reintenta estados none y pending, limita concurrencia y solo consulta metadatos de Drive', async () => {
    let finish: (value: string) => void = () => undefined;
    const token = vi.fn().mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    const query = vi.fn().mockImplementation(async (sql: string) => sql.startsWith('UPDATE meeting_reviews review SET recording_checked_at') ? { rows: [source] } : sql.startsWith('SELECT google_file_id') ? { rows: [video] } : { rows: [] });
    const drive = vi.fn().mockResolvedValue(new Response(JSON.stringify(video)));
    const service = createMeetingRecordingService({ query } as unknown as Pool, { token, drive, events: vi.fn().mockResolvedValue([]) });
    service.schedule(source.id);
    service.schedule(source.id);
    await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(1));
    finish('test-token');
    await vi.waitFor(() => expect(drive).toHaveBeenCalledTimes(1));
    expect(drive.mock.calls[0][0]).toContain('/files/video123456?');
    expect(drive.mock.calls[0][0]).not.toMatch(/permissions|alt=media/);
    expect(query.mock.calls[0][0]).toContain("recording_status<>'available'");
    expect(query.mock.calls[0][0]).toContain("INTERVAL '5 minutes'");
    expect(query.mock.calls[1][1]).toEqual([source.connection_id]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(expect.stringContaining('recording_file_id=$2'), [source.id, video.id, 'available']));
  });
  it('un origen pausado no consulta Google y un error no pasa a none', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const token = vi.fn().mockRejectedValue(new Error('Forbidden'));
    const service = createMeetingRecordingService({ query } as unknown as Pool, { token, drive: vi.fn() });
    await service.refresh(source.id);
    expect(token).not.toHaveBeenCalled();
    query.mockResolvedValueOnce({ rows: [source] });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await service.refresh(source.id);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("recording_status='pending'"), [source.id]);
    warning.mockRestore();
  });
});
