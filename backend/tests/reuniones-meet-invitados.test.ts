// Invitados de las reuniones de Meet desde Calendar (869fppbcj). Sin red ni base de datos.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCalendar, eventoCalendar, eventoDeAsignacion, invitadosDelEvento } from '../reuniones-meet/invitados.ts';

describe('invitadosDelEvento', () => {
  it('quita salas y repetidos, normaliza el email y marca quién es del equipo', () => {
    const evento = { attendees: [
      { email: 'Ernesto@GrupoLyn.com', displayName: 'Ernesto Pérez', responseStatus: 'accepted', organizer: true },
      { email: 'maria.garcia@gmail.com', responseStatus: 'needsAction' },
      { email: 'MARIA.GARCIA@gmail.com' },
      { email: 'c_123@resource.calendar.google.com', displayName: 'Sala 1', resource: true },
      { email: 'no-es-un-email' },
    ] };
    expect(invitadosDelEvento(evento, new Set(['ernesto@grupolyn.com']))).toEqual([
      { email: 'ernesto@grupolyn.com', nombre: 'Ernesto Pérez', respuesta: 'accepted', organizador: true, interno: true },
      { email: 'maria.garcia@gmail.com', nombre: null, respuesta: 'needsAction', organizador: false, interno: false },
    ]);
  });

  it('evento sin invitados: lista vacía', () => {
    expect(invitadosDelEvento({}, new Set())).toEqual([]);
  });
});

describe('eventoDeAsignacion', () => {
  it('solo los organizadores que vinculó Calendar tienen evento', () => {
    expect(eventoDeAsignacion('calendar:abc123_20261110')).toBe('abc123_20261110');
    expect(eventoDeAsignacion('manual:usuario-7')).toBeNull();
    expect(eventoDeAsignacion(null)).toBeNull();
  });
});

describe('eventoCalendar', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pide un solo evento, solo lectura y solo los campos de invitados', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'ev/1', attendees: [] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await eventoCalendar('token', 'ev/1')).toEqual({ id: 'ev/1', attendees: [] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain('/calendars/primary/events/ev%2F1?');
    expect(decodeURIComponent(url)).toContain('attendees(email,displayName,responseStatus,organizer,resource)');
    expect(init.method).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer token');
  });

  it('un error guarda el código HTTP para decidir si se reintenta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const error = await eventoCalendar('token', 'ev').catch((e) => e);
    expect(error).toBeInstanceOf(ErrorCalendar);
    expect(error.status).toBe(404);
  });
});
