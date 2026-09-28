import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CEOApp from '../src/ceo-dashboard/App';
import { initialDashboardView, isCeoView, shouldPollWhatsappConnection } from '../src/ceo-dashboard/CeoLogin';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  meetings: { workItems: vi.fn(), markWorkItemsRead: vi.fn() },
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
});
