export type CalendarMeeting = {
  id?: string;
  status?: string;
  organizer?: { email?: string };
  attachments?: Array<{ fileId?: string }>;
  hangoutLink?: string;
  conferenceData?: { conferenceId?: string };
};

export function calendarOrganizer(events: CalendarMeeting[], fileId: string, sourceText: string): { email: string; eventId: string } | null {
  const codes = new Set((sourceText.toLowerCase().match(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/g) || []));
  const matches = events.filter((event) => event.status !== 'cancelled' && (
    event.attachments?.some((attachment) => attachment.fileId === fileId)
    || (codes.size === 1 && (codes.has(String(event.conferenceData?.conferenceId || '').toLowerCase())
      || [...codes].some((code) => event.hangoutLink === `https://meet.google.com/${code}`)))
  ));
  if (matches.length !== 1 || !matches[0].id) return null;
  const email = String(matches[0].organizer?.email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email, eventId: matches[0].id } : null;
}

export async function calendarEventsForDate(accessToken: string, date: string): Promise<CalendarMeeting[]> {
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return [];
  const params = new URLSearchParams({
    timeMin: new Date(day.getTime() - 86400000).toISOString(),
    timeMax: new Date(day.getTime() + 2 * 86400000).toISOString(),
    singleEvents: 'true', maxResults: '2500',
    fields: 'nextPageToken,items(id,status,organizer(email),attachments(fileId),hangoutLink,conferenceData(conferenceId))',
  });
  const events: CalendarMeeting[] = [];
  const pages = new Set<string>();
  const signal = AbortSignal.timeout(30000);
  do {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal,
    });
    if (!response.ok) throw new Error(`No se pudo consultar el organizador en Calendar (${response.status}).`);
    const payload = await response.json() as { items?: CalendarMeeting[]; nextPageToken?: string };
    events.push(...(payload.items || []));
    if (!payload.nextPageToken) return events;
    if (pages.has(payload.nextPageToken)) throw new Error('Calendar devolvió una página repetida.');
    pages.add(payload.nextPageToken);
    params.set('pageToken', payload.nextPageToken);
  } while (!signal.aborted);
  throw new Error('La consulta del organizador agotó el tiempo de espera.');
}
