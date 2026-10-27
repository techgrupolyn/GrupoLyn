import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CEOApp from '../src/ceo-dashboard/App';
import { initialDashboardView, isCeoView, shouldPollWhatsappConnection } from '../src/ceo-dashboard/CeoLogin';
import api from '../src/ceo-dashboard/api';

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  meetings: { workItems: vi.fn(), markWorkItemsRead: vi.fn() },
  netelip: { calls: vi.fn(), filterOptions: vi.fn() },
} }));
vi.mock('../src/ceo-dashboard/views/MeetingManagementView', () => ({ default: ({ openMeetingId }) => <div data-testid="meetings">Reuniones {openMeetingId}</div> }));

describe('Mis pendientes para usuarios limitados', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    window.history.replaceState({}, '', '/?view=meetings');
    api.meetings.workItems.mockResolvedValue({ items: [{ key: 'action-qa', artifactId: 'meeting-qa', kind: 'action', title: 'Revisar reunión QA', meetingName: 'Comité QA', unread: true }], unread: 1, total: 1, actions: 1, reviews: 0 });
    api.meetings.markWorkItemsRead.mockResolvedValue({ ok: true });
  });

  it.each(['employee:delineante', 'employee:pmc_proyectos', 'employee:interiorista', 'superadmin'])('abre la lista desde el menú con %s', async (rol) => {
    render(<CEOApp user={{ usuario: 'qa', nombre: 'Usuario QA', rol }} />);
    fireEvent.click(screen.getByRole('button', { name: /Mis pendientes/ }));
    expect(await screen.findByText('Revisar reunión QA')).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('work'));
    expect(screen.queryByTestId('meetings')).not.toBeInTheDocument();
    if (rol !== 'superadmin') expect(screen.queryByRole('button', { name: 'Backoffice' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Revisar reunión QA/ }));
    expect(await screen.findByTestId('meetings')).toHaveTextContent('meeting-qa');
    expect(api.meetings.markWorkItemsRead).toHaveBeenCalledWith(['action-qa']);
  });

  it('admite entrada directa y recarga en work sin activar WhatsApp', async () => {
    expect(initialDashboardView('?view=work', 'localhost')).toBe('work');
    expect(isCeoView('work')).toBe(true);
    expect(shouldPollWhatsappConnection('work', false)).toBe(false);
    window.history.replaceState({}, '', '/?view=work');
    render(<CEOApp user={{ usuario: 'qa', rol: 'employee:delineante' }} />);
    expect(await screen.findByText('Revisar reunión QA')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('work');
  });

  it('abre Ver todo desde las notificaciones sin volver a reuniones', async () => {
    render(<CEOApp user={{ usuario: 'qa', rol: 'employee:delineante' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir mis notificaciones' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ver todo' }));
    expect(await screen.findByText('Revisar reunión QA')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('work');
  });

  it('conserva los pendientes visibles si una actualización falla', async () => {
    let refresh;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 30_000) refresh = callback;
      return 12345;
    });
    window.history.replaceState({}, '', '/?view=work');
    const view = render(<CEOApp user={{ usuario: 'qa', rol: 'employee:delineante' }} />);
    try {
      await screen.findByText('Revisar reunión QA');
      api.meetings.workItems.mockRejectedValueOnce(new Error('Temporal'));
      await act(async () => { refresh(); });
      expect(screen.getByText('Revisar reunión QA')).toBeVisible();
      expect(api.meetings.workItems).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); interval.mockRestore(); }
  });
});

describe('Netelip · visibilidad en la barra lateral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    api.meetings.workItems.mockResolvedValue({ items: [], unread: 0, total: 0, actions: 0, reviews: 0 });
  });

  it.each(['superadmin', 'admin', 'employee:director'])('muestra Historial de llamadas a %s', async (rol) => {
    window.history.replaceState({}, '', '/?view=work');
    render(<CEOApp user={{ usuario: 'qa', rol }} />);
    expect(await screen.findByRole('button', { name: 'Historial de llamadas' })).toBeInTheDocument();
  });

  it.each(['employee:direccion_de_operaciones', 'ceo', 'employee:delineante'])('lo oculta a %s y por URL directa avisa de que no tiene permisos', async (rol) => {
    window.history.replaceState({}, '', '/?view=netelip');
    render(<CEOApp user={{ usuario: 'qa', rol }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permisos para ver el historial de llamadas');
    expect(screen.queryByRole('button', { name: 'Historial de llamadas' })).not.toBeInTheDocument();
    expect(api.netelip.calls).not.toHaveBeenCalled();
  });
});
