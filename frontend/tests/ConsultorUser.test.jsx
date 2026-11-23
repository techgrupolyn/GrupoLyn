import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CEOApp from '../src/ceo-dashboard/App';
import api from '../src/ceo-dashboard/api';

// Usuario del superagente con el rol consultor_lectura (p. ej. una agencia de marketing): Netelip y reuniones, en solo lectura.
configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  meetings: { workItems: vi.fn(), markWorkItemsRead: vi.fn(), list: vi.fn(), filterOptions: vi.fn(), get: vi.fn(), recording: vi.fn() },
  projectMeetings: { mode: vi.fn() },
  directory: { overview: vi.fn() },
  metrics: vi.fn(),
  netelip: { calls: vi.fn(), filterOptions: vi.fn() },
  captacionLlamadas: { sinAsignar: vi.fn() },
  decisiones: { bandeja: vi.fn(), acierto: vi.fn() },
} }));

const usuario = { usuario: 'agencia', nombre: 'Agencia', rol: 'consultor_lectura' };
const reunion = {
  id: 'reunion-1', name: 'Reunión ficticia', meeting_date: '2026-09-01', meeting_kind: 'MEET', analysis_status: 'completed', workflow_stage: 'pmc', status: 'pending',
  summary: 'Resumen ficticio', decisions: '', actions: [{ id: 'a1', title: 'Acción ficticia' }], blockers: { missingResponsible: 0, missingDueDate: 0 }, detected_blockers: [], versions: [],
  permissions: { manageActions: false, deleteActions: false, editMeeting: false, review: false, assignOrganizer: false },
};

describe('Dashboard del consultor de solo lectura', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    api.netelip.calls.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 1, metrics: {}, can_read_transcripts: true });
    api.netelip.filterOptions.mockResolvedValue({ agents: [] });
    api.captacionLlamadas.sinAsignar.mockResolvedValue({ resumen: {}, items: [] });
    api.meetings.list.mockResolvedValue({ items: [reunion], page: 1, pageSize: 25, total: 1, totalPages: 1, metrics: {} });
    api.meetings.filterOptions.mockResolvedValue({ pmcs: [] });
    api.meetings.get.mockResolvedValue(reunion);
  });

  it('solo ve Historial de llamadas y Gestión de reuniones, aunque la URL pida otra vista, y sin notificaciones', async () => {
    window.history.replaceState({}, '', '/?view=settings');
    render(<CEOApp user={usuario} />);
    expect(await screen.findByRole('heading', { name: 'Historial de llamadas', level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('netelip'));
    const labels = [...screen.getByRole('navigation').querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toEqual(['Historial de llamadas', 'Gestión de reunionesNuevo']);
    expect(screen.queryByRole('button', { name: 'Abrir mis notificaciones' })).not.toBeInTheDocument();
    expect(screen.getByText('Consultor · solo lectura')).toBeInTheDocument();
    expect(api.meetings.workItems).not.toHaveBeenCalled();
    expect(api.metrics).not.toHaveBeenCalled();
  });

  it('ve todas las reuniones en solo lectura: sin flujo por proyecto, directorio ni botones de edición', async () => {
    window.history.replaceState({}, '', '/?view=meetings');
    render(<CEOApp user={usuario} />);
    fireEvent.click(await screen.findByText('Reunión ficticia'));
    expect(await screen.findByText('Acceso de lectura')).toBeInTheDocument();
    expect(screen.getByText('Resumen ficticio')).toBeInTheDocument();
    expect(screen.getByText('Acción ficticia')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Añadir acción|Aprobar|Guardar borrador|Reanalizar PMC|Vincular directorio/ })).not.toBeInTheDocument();
    expect(api.projectMeetings.mode).not.toHaveBeenCalled();
    expect(api.directory.overview).not.toHaveBeenCalled();
  });
});
