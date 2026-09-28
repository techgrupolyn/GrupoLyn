import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarEventsForDate, calendarOrganizer } from '../meeting-organizer.ts';

describe('Organizador de reunión con evidencia de Calendar', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('vincula por archivo adjunto y normaliza el correo, no por propietario de Drive', () => {
    expect(calendarOrganizer([{ id: 'event', attachments: [{ fileId: 'file' }], organizer: { email: 'USER@example.com' } }], 'file', '')).toEqual({ email: 'user@example.com', eventId: 'event' });
  });
  it('acepta código Meet único y rechaza eventos ambiguos, cancelados o sin correo', () => {
    const event = { id: 'event', conferenceData: { conferenceId: 'abc-defg-hij' }, organizer: { email: 'one@example.com' } };
    expect(calendarOrganizer([event], 'file', 'abc-defg-hij')).not.toBeNull();
    expect(calendarOrganizer([event, { ...event, id: 'other' }], 'file', 'abc-defg-hij')).toBeNull();
    expect(calendarOrganizer([{ ...event, status: 'cancelled' }], 'file', 'abc-defg-hij')).toBeNull();
    expect(calendarOrganizer([{ ...event, organizer: {} }], 'file', 'abc-defg-hij')).toBeNull();
    expect(calendarOrganizer([event], 'file', 'Reunión de one@example.com')).toBeNull();
  });
  it('consulta todas las páginas sin escribir en Calendar', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'one' }], nextPageToken: 'next' }))).mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'two' }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await calendarEventsForDate('test', '2026-09-25')).toHaveLength(2);
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=next');
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it('no acepta evidencia parcial si Calendar falla', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(calendarEventsForDate('test', '2026-09-25')).rejects.toThrow('403');
  });
});
