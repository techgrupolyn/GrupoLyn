import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: { netelip: { calls: vi.fn(), call: vi.fn(), filterOptions: vi.fn() } },
}));

import api from '../src/ceo-dashboard/api';
import NetelipCallsView from '../src/ceo-dashboard/views/NetelipCallsView';
import { callListQuery, formatDuration, formatMadridDateTime, formatPhone, madridDayStartIso, readCallFilters, writeCallFilters } from '../src/ceo-dashboard/netelipFormat';

const metrics = { calls: 3, unidentified: 2, transcription_pending: 1, transcription_failed: 0 };
const calls = [
  { id: 1, via: 'phone', direction: 'inbound', occurred_at: '2026-11-15T08:47:00Z', phone: '+34600000101', contact_status: 'matched', contact: { type: 'client', id: 'c1', name: 'Lucía Ficticia' }, agent: { extension: '109', name: 'Elena Prueba' }, duration_seconds: 95, transcription_status: 'completed' },
  { id: 2, via: 'whatsapp', direction: 'outbound', occurred_at: '2026-11-15T07:00:00Z', phone: '+34699123456', contact_status: 'unknown', contact: null, agent: { extension: '113', name: null }, duration_seconds: 42, transcription_status: 'pending' },
  { id: 3, via: 'phone', direction: 'inbound', occurred_at: '2026-11-15T06:00:00Z', phone: null, contact_status: 'hidden', contact: null, agent: null, duration_seconds: 20, transcription_status: 'failed' },
  { id: 4, via: 'phone', direction: 'inbound', occurred_at: '2026-11-15T05:00:00Z', phone: '+34600000999', contact_status: 'multiple', contact: null, agent: null, duration_seconds: 20, transcription_status: 'completed' },
];
const page = (items, extra = {}) => ({ items, page: 1, pageSize: 25, total: items.length, totalPages: 1, metrics, can_read_transcripts: true, ...extra });

beforeEach(() => {
  window.history.replaceState({}, '', '/?view=netelip');
  vi.mocked(api.netelip.calls).mockResolvedValue(page(calls));
  vi.mocked(api.netelip.filterOptions).mockResolvedValue({ agents: [{ extension: '109', name: 'Elena Prueba' }] });
  vi.mocked(api.netelip.call).mockResolvedValue({ call: calls[0], transcription_access: 'granted', transcription: { status: 'completed', text: 'Hola', segments: [{ speaker: 'agente', start: 0, end: 2, text: 'Buenos días.' }, { speaker: 'cliente', start: 2.4, end: 4, text: 'Hola, dígame.' }] } });
});
afterEach(() => vi.clearAllMocks());

describe('Netelip · formato', () => {
  it('muestra la hora de Madrid', () => {
    expect(formatMadridDateTime('2026-11-15T08:47:00Z')).toBe('15/11/2026 09:47');
    expect(formatMadridDateTime('2026-07-15T08:47:00Z')).toBe('15/07/2026 10:47');
  });
  it('convierte el día de Madrid a UTC, con y sin horario de verano', () => {
    expect(madridDayStartIso('2026-11-15')).toBe('2026-11-14T23:00:00.000Z');
    expect(madridDayStartIso('2026-07-15')).toBe('2026-07-14T22:00:00.000Z');
  });
  it('formatea duración y teléfono', () => {
    expect(formatDuration(95)).toBe('01:35');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatPhone('+34600000101')).toBe('+34 600 000 101');
    expect(formatPhone('+573001234567')).toBe('+573001234567');
  });
  it('lee y escribe los filtros en la URL sin tocar otros parámetros', () => {
    const url = writeCallFilters(new URL('http://x/?view=netelip&tab=a'), { ...readCallFilters(''), dir: 'inbound', call: '7', page: 2 });
    expect(url.search).toBe('?view=netelip&tab=a&dir=inbound&page=2&call=7');
    expect(readCallFilters(url.search)).toMatchObject({ dir: 'inbound', call: '7', page: 2 });
  });
  it('traduce los filtros a la consulta del servidor', () => {
    const query = new URLSearchParams(callListQuery({ ...readCallFilters(''), dir: 'outbound', tr: 'failed', period: 'custom', from: '2026-11-01', to: '2026-11-15', sort: 'oldest' }));
    expect(Object.fromEntries(query)).toMatchObject({ direction: 'outbound', transcription: 'failed', sort: 'occurred_at_asc', from: '2026-10-31T23:00:00.000Z', to: '2026-11-15T23:00:00.000Z' });
  });
});

describe('NetelipCallsView', () => {
  it('muestra lead o cliente vinculado, sin contacto, número oculto y coincidencia múltiple', async () => {
    render(<NetelipCallsView />);
    await screen.findByText('Lucía Ficticia');
    const rows = screen.getAllByRole('row');
    const body = rows.slice(1);
    expect(within(body[0]).getByText('Lucía Ficticia')).toBeInTheDocument();
    expect(within(body[0]).getByText('Cliente')).toBeInTheDocument();
    expect(within(body[0]).getByText('15/11/2026 09:47')).toBeInTheDocument();
    expect(within(body[0]).getByText('+34 600 000 101')).toBeInTheDocument();
    expect(within(body[1]).getByText('Sin contacto identificado')).toBeInTheDocument();
    expect(within(body[1]).getByText('+34 699 123 456')).toBeInTheDocument();
    expect(within(body[1]).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(body[1]).getByText('Extensión 113')).toBeInTheDocument();
    expect(within(body[2]).getByText('Número oculto')).toBeInTheDocument();
    expect(within(body[2]).getByText('Fallida')).toBeInTheDocument();
    expect(within(body[1]).getByText('En cola')).toBeInTheDocument();
    expect(within(body[3]).getByText('Coincidencia múltiple')).toBeInTheDocument();
  });

  it('abre la transcripción en el panel lateral con turnos y deja la llamada en la URL', async () => {
    render(<NetelipCallsView />);
    fireEvent.click(await screen.findByText('15/11/2026 09:47'));
    const drawer = await screen.findByRole('dialog', { name: 'Detalle de llamada' });
    expect(await within(drawer).findByText('Buenos días.')).toBeInTheDocument();
    expect(within(drawer).getByText('GRUPO LYN:')).toBeInTheDocument();
    expect(within(drawer).getByText('CLIENTE:')).toBeInTheDocument();
    expect(window.location.search).toContain('call=1');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).not.toContain('call=');
  });

  it('abre directamente la llamada que viene en la URL', async () => {
    window.history.replaceState({}, '', '/?view=netelip&call=1&dir=inbound');
    render(<NetelipCallsView />);
    expect(await screen.findByRole('dialog', { name: 'Detalle de llamada' })).toBeInTheDocument();
    expect(api.netelip.call).toHaveBeenCalledWith('1');
    expect(vi.mocked(api.netelip.calls).mock.calls[0][0]).toContain('direction=inbound');
  });

  it('sin permiso, el panel lo indica y no hay texto', async () => {
    vi.mocked(api.netelip.call).mockResolvedValue({ call: calls[0], transcription_access: 'denied', transcription: { status: 'completed' } });
    window.history.replaceState({}, '', '/?view=netelip&call=1');
    render(<NetelipCallsView />);
    expect(await screen.findByText(/No tienes permiso para leer transcripciones/)).toBeInTheDocument();
    expect(screen.queryByText('Buenos días.')).not.toBeInTheDocument();
  });

  it.each([
    ['pending', /la llamada está en cola/],
    ['failed', /No se pudo transcribir esta llamada/],
  ])('estado de transcripción %s', async (status, text) => {
    vi.mocked(api.netelip.call).mockResolvedValue({ call: calls[0], transcription_access: 'granted', transcription: { status } });
    window.history.replaceState({}, '', '/?view=netelip&call=1');
    render(<NetelipCallsView />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('muestra «En cola» y la barra de avance mientras se transcribe', async () => {
    vi.mocked(api.netelip.calls).mockResolvedValue(page([
      { ...calls[1], transcription_phase: 'queued', transcription_progress: null },
      { ...calls[0], id: 9, transcription_status: 'pending', transcription_phase: 'processing', transcription_progress: 45 },
    ]));
    render(<NetelipCallsView />);
    expect(await screen.findByText('En cola')).toBeInTheDocument();
    expect(screen.getByText('Transcribiendo · 45 %')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Avance de la transcripción' })).toHaveAttribute('aria-valuenow', '45');
  });

  it('distingue «sin llamadas» de «sin resultados de filtro»', async () => {
    vi.mocked(api.netelip.calls).mockResolvedValue(page([], { metrics: { calls: 0, unidentified: 0, transcription_pending: 0, transcription_failed: 0 } }));
    const { unmount } = render(<NetelipCallsView />);
    expect(await screen.findByText(/Todavía no hay llamadas grabadas/)).toBeInTheDocument();
    unmount();
    window.history.replaceState({}, '', '/?view=netelip&tr=failed');
    render(<NetelipCallsView />);
    expect(await screen.findByText(/No hay llamadas que coincidan con los filtros/)).toBeInTheDocument();
  });

  it('muestra el estado de carga y los indicadores aplican su filtro', async () => {
    let resolve;
    vi.mocked(api.netelip.calls).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<NetelipCallsView />);
    expect(screen.getByText('Cargando llamadas…')).toBeInTheDocument();
    resolve(page(calls));
    fireEvent.click(await screen.findByRole('button', { name: /Sin contacto identificado/ }));
    await waitFor(() => expect(vi.mocked(api.netelip.calls).mock.lastCall[0]).toContain('contact=unidentified'));
    expect(window.location.search).toContain('contact=unidentified');
  });

  it('el enlace del contacto abre su ficha', async () => {
    const onOpenContact = vi.fn();
    render(<NetelipCallsView onOpenContact={onOpenContact} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lucía Ficticia' }));
    expect(onOpenContact).toHaveBeenCalledWith({ type: 'client', id: 'c1', name: 'Lucía Ficticia' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
