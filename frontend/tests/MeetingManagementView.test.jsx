import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: {
    directory: {
      overview: vi.fn(),
    },
    meetings: {
      list: vi.fn(),
      filterOptions: vi.fn(),
      reanalyzeMissingPmc: vi.fn(),
      retag: vi.fn(),
      get: vi.fn(),
      assignResponsible: vi.fn(),
      manageAdditionalResponsible: vi.fn(),
    },
  },
}));

import api from '../src/ceo-dashboard/api';
import MeetingManagementView from '../src/ceo-dashboard/views/MeetingManagementView';

const emptyList = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0, metrics: {} };
const meeting = {
  id: 'meeting-1',
  name: 'Comité de obra · Prueba',
  meeting_date: '2026-09-01',
  meeting_kind: 'COMITE_OBRA',
  analysis_status: 'completed',
  workflow_stage: 'agent',
  status: 'draft',
  actions: [],
  blockers: { missingResponsible: 0, missingDueDate: 0 },
  detected_blockers: [],
  versions: [],
  summary: '',
  decisions: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.directory.overview).mockResolvedValue({ employees: [], clients: [], projects: [] });
  vi.mocked(api.meetings.list).mockResolvedValue(emptyList);
  vi.mocked(api.meetings.filterOptions).mockResolvedValue({ pmcs: [] });
  vi.mocked(api.meetings.reanalyzeMissingPmc).mockResolvedValue({ queued: 0 });
  vi.mocked(api.meetings.retag).mockResolvedValue({});
  vi.mocked(api.meetings.get).mockResolvedValue(meeting);
});

describe('MeetingManagementView', () => {
  it('abre el panel inmediatamente y permite cerrarlo antes de recibir el detalle', async () => {
    let finish;
    vi.mocked(api.meetings.get).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    render(<MeetingManagementView />);
    fireEvent.click(await screen.findByText(meeting.name));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Cargando reunión…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar', exact: true }));
    await act(async () => { finish(meeting); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('permite reintentar el detalle fallido desde el panel', async () => {
    vi.mocked(api.meetings.get).mockRejectedValueOnce(new Error('Servidor ocupado'));
    render(<MeetingManagementView openMeetingId={meeting.id} />);
    expect(await screen.findByText('Servidor ocupado')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('heading', { name: meeting.name })).toBeVisible();
    expect(api.meetings.get).toHaveBeenCalledTimes(2);
  });

  it('no repite la petición de detalle si cambia el callback del padre', async () => {
    let finish;
    vi.mocked(api.meetings.get).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<MeetingManagementView openMeetingId={meeting.id} onMeetingOpened={() => {}} />);
    view.rerender(<MeetingManagementView openMeetingId={meeting.id} onMeetingOpened={() => {}} />);
    expect(api.meetings.get).toHaveBeenCalledTimes(1);
    await act(async () => { finish(meeting); });
    expect(await screen.findByRole('heading', { name: meeting.name })).toBeVisible();
  });

  it('muestra la lista sin esperar a los filtros y no vuelve a pedirlos al filtrar', async () => {
    vi.mocked(api.meetings.filterOptions).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    render(<MeetingManagementView />);
    expect(await screen.findByText(meeting.name)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Aprobadas' }));
    await waitFor(() => expect(api.meetings.list).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'approved' })));
    expect(api.meetings.filterOptions).toHaveBeenCalledTimes(1);
  });

  it('agrupa las pulsaciones de búsqueda en una sola petición', async () => {
    render(<MeetingManagementView />);
    await waitFor(() => expect(api.meetings.list).toHaveBeenCalledTimes(1));
    const search = screen.getByPlaceholderText('Buscar contacto, teléfono, email u obra…');
    fireEvent.change(search, { target: { value: 'Da' } });
    fireEvent.change(search, { target: { value: 'Dan' } });
    fireEvent.change(search, { target: { value: 'Dana' } });
    expect(api.meetings.list).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.meetings.list).toHaveBeenCalledTimes(2));
    expect(api.meetings.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'Dana', page: 1 }));
  });

  it('descarta respuestas antiguas cuando cambia el filtro', async () => {
    let finishOld;
    vi.mocked(api.meetings.list).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    render(<MeetingManagementView />);
    fireEvent.click(screen.getByRole('button', { name: 'Aprobadas' }));
    await screen.findByText('No hay reuniones que coincidan con los filtros.');
    await act(async () => { finishOld({ ...emptyList, items: [meeting] }); });
    expect(screen.queryByText(meeting.name)).not.toBeInTheDocument();
  });

  it('no vuelve a abrir el detalle si llega una actualización después de cerrarlo', async () => {
    let refreshDetail;
    let finishDetail;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 15_000) refreshDetail = callback;
      return 12345;
    });
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    const view = render(<MeetingManagementView />);
    try {
      fireEvent.click(await screen.findByText(meeting.name));
      await screen.findByRole('heading', { name: meeting.name });
      vi.mocked(api.meetings.get).mockImplementationOnce(() => new Promise((resolve) => { finishDetail = resolve; }));
      await act(async () => { refreshDetail(); });
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }));
      await act(async () => { finishDetail(meeting); });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally { view.unmount(); interval.mockRestore(); }
  });

  it('no acumula consultas de lista mientras la anterior sigue pendiente', async () => {
    let refresh;
    let finish;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 15_000) refresh = callback;
      return 12345;
    });
    vi.mocked(api.meetings.list).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<MeetingManagementView />);
    try {
      await act(async () => { refresh(); refresh(); });
      expect(api.meetings.list).toHaveBeenCalledTimes(1);
      await act(async () => { finish(emptyList); });
      await act(async () => { refresh(); });
      expect(api.meetings.list).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); interval.mockRestore(); }
  });

  it('muestra todos los delineantes en un desplegable sin abrir la reunión al expandirlo', async () => {
    const teamMeeting = { ...meeting, project_name: 'Obra QA', pmc_assignments: [
      { employee_id: 'first', name: 'Primera persona', in_training: true },
      { employee_id: 'second', name: 'Segunda persona', in_training: true },
    ] };
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [teamMeeting], total: 1, totalPages: 1 });
    vi.mocked(api.meetings.get).mockResolvedValue(teamMeeting);
    render(<MeetingManagementView />);
    fireEvent.click(await screen.findByText('Equipo del proyecto · 2'));
    expect(api.meetings.get).not.toHaveBeenCalled();
    expect(screen.getByText('Primera persona · PMC en prácticas')).toBeVisible();
    expect(screen.getByText('Segunda persona · PMC en prácticas')).toBeVisible();
    expect(screen.queryByText('PMC pendiente de vincular')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(meeting.name));
    await screen.findByRole('heading', { name: meeting.name });
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByText('Equipo del proyecto · 2'));
    expect(within(drawer).getByText('Segunda persona · PMC en prácticas')).toBeVisible();
  });
  it('identifica al delineante de respaldo como PMC en prácticas en lista y detalle', async () => {
    const traineeMeeting = { ...meeting, pmc: 'Delineante QA', pmc_employee_id: 'trainee-1', pmc_in_training: true };
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [traineeMeeting], total: 1, totalPages: 1 });
    vi.mocked(api.meetings.get).mockResolvedValue(traineeMeeting);
    render(<MeetingManagementView />);
    expect(await screen.findByText('PMC en prácticas: Delineante QA')).toBeInTheDocument();
    fireEvent.click(screen.getByText(meeting.name));
    await waitFor(() => expect(screen.getAllByText('PMC en prácticas: Delineante QA')).toHaveLength(2));
  });

  it.each([false, true])('muestra reuniones nuevas automáticamente sin pulsar sincronizar (acceso limitado: %s)', async (limitedAccess) => {
    let refresh;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 15_000) refresh = callback;
      return 12345;
    });
    const view = render(<MeetingManagementView limitedAccess={limitedAccess} canEdit={!limitedAccess} />);
    try {
      await waitFor(() => expect(api.meetings.list).toHaveBeenCalled());
      expect(screen.queryByText(meeting.name)).not.toBeInTheDocument();
      vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
      await act(async () => { refresh(); });
      expect(await screen.findByText(meeting.name)).toBeInTheDocument();
    } finally {
      view.unmount();
      interval.mockRestore();
    }
  });

  it('no muestra un bloqueo por aviso de Meet aunque reciba el campo antiguo', async () => {
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [{ ...meeting, analysis_status: 'pending', recording_notice_required: true }], total: 1, totalPages: 1 });
    render(<MeetingManagementView />);
    expect(await screen.findByText('Comité de obra · Prueba')).toBeInTheDocument();
    expect(screen.queryByText('Pendiente de registrar aviso en Meet')).not.toBeInTheDocument();
  });

  it('reasigna el responsable desde el directorio y conserva la categoría seleccionada', async () => {
    const actionMeeting = {
      ...meeting,
      actions: [{ id: 'action-1', title: 'Revisar planos', responsible: 'Ana Responsable', responsible_id: 'employee-1', responsible_kind: 'employee', responsible_role: 'Planimetrista', due_date: null, status: 'pending', responsibles: [{ employee_id: 'employee-1', name: 'Ana Responsable', role: 'Planimetrista' }] }],
    };
    vi.mocked(api.directory.overview).mockResolvedValue({
      employees: [
        { id: 'employee-1', nombre: 'Ana', apellido: 'Responsable', activo: true, roles: ['Planimetrista'] },
        { id: 'employee-2', nombre: 'Construcciones', apellido: 'Norte', activo: true, roles: ['Subcontrata'] },
      ],
      clients: [{ id: 'client-1', nombre: 'Marta', apellido: 'Cliente', activo: true }],
      projects: [],
    });
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    vi.mocked(api.meetings.get).mockResolvedValue(actionMeeting);
    vi.mocked(api.meetings.assignResponsible).mockResolvedValue({ changed: true });
    render(<MeetingManagementView />);

    fireEvent.click(await screen.findByText(meeting.name));
    fireEvent.click(await screen.findByRole('button', { name: 'Cambiar responsable: Ana Responsable' }));
    fireEvent.change(screen.getByLabelText('Buscar responsable'), { target: { value: 'Marta' } });
    expect(screen.getByText('Clientes')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Resultados de responsables' })).getByRole('option', { name: /Marta Cliente/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsable' }));

    await waitFor(() => expect(api.meetings.assignResponsible).toHaveBeenCalledWith('meeting-1', 'action-1', { kind: 'client', id: 'client-1' }));
  });
  it('permite añadir un responsable adicional desde el buscador', async () => {
    const actionMeeting = {
      ...meeting,
      actions: [{ id: 'action-1', title: 'Revisar planos', responsible: 'Ana Responsable', responsible_id: 'employee-1', responsible_kind: 'employee', responsible_role: 'Planimetrista', due_date: null, status: 'pending', responsibles: [{ responsible_id: 'employee-1', responsible_kind: 'employee', employee_id: 'employee-1', name: 'Ana Responsable', role: 'Planimetrista' }] }],
    };
    vi.mocked(api.directory.overview).mockResolvedValue({
      employees: [
        { id: 'employee-1', nombre: 'Ana', apellido: 'Responsable', activo: true, roles: ['Planimetrista'] },
        { id: 'employee-2', nombre: 'Construcciones', apellido: 'Norte', activo: true, roles: ['Subcontrata'] },
      ],
      clients: [],
      projects: [],
    });
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    vi.mocked(api.meetings.get).mockResolvedValue(actionMeeting);
    vi.mocked(api.meetings.manageAdditionalResponsible).mockResolvedValue({ changed: true });
    render(<MeetingManagementView />);

    fireEvent.click(await screen.findByText(meeting.name));
    fireEvent.click(await screen.findByRole('button', { name: 'Añadir responsables adicionales' }));
    fireEvent.change(screen.getByLabelText('Buscar responsable'), { target: { value: 'Construcciones' } });
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Resultados de responsables' })).getByRole('option', { name: /Construcciones Norte/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsable' }));

    await waitFor(() => expect(api.meetings.manageAdditionalResponsible).toHaveBeenCalledWith('meeting-1', 'action-1', { kind: 'employee', id: 'employee-2' }));
  });
  it('permite reemplazar un responsable adicional sin modificar el principal', async () => {
    const actionMeeting = {
      ...meeting,
      actions: [{ id: 'action-1', title: 'Revisar planos', responsible: 'Ana Responsable', responsible_id: 'employee-1', responsible_kind: 'employee', responsible_role: 'Planimetrista', due_date: null, status: 'pending', responsibles: [
        { responsible_id: 'employee-1', responsible_kind: 'employee', employee_id: 'employee-1', name: 'Ana Responsable', role: 'Planimetrista' },
        { responsible_id: 'employee-2', responsible_kind: 'employee', employee_id: 'employee-2', name: 'Construcciones Norte', role: 'Subcontrata' },
      ] }],
    };
    vi.mocked(api.directory.overview).mockResolvedValue({
      employees: [
        { id: 'employee-1', nombre: 'Ana', apellido: 'Responsable', activo: true, roles: ['Planimetrista'] },
        { id: 'employee-2', nombre: 'Construcciones', apellido: 'Norte', activo: true, roles: ['Subcontrata'] },
      ],
      clients: [{ id: 'client-1', nombre: 'Marta', apellido: 'Cliente', activo: true }],
      projects: [],
    });
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    vi.mocked(api.meetings.get).mockResolvedValue(actionMeeting);
    vi.mocked(api.meetings.manageAdditionalResponsible).mockResolvedValue({ changed: true });
    render(<MeetingManagementView />);

    fireEvent.click(await screen.findByText(meeting.name));
    fireEvent.click(await screen.findByRole('button', { name: /Ver 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /Construcciones Norte/i }));
    fireEvent.change(screen.getByLabelText('Buscar responsable'), { target: { value: 'Marta' } });
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Resultados de responsables' })).getByRole('option', { name: /Marta Cliente/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsable' }));

    await waitFor(() => expect(api.meetings.manageAdditionalResponsible).toHaveBeenCalledWith('meeting-1', 'action-1', { kind: 'client', id: 'client-1', previous_kind: 'employee', previous_id: 'employee-2' }));
  });
  it('opens a meeting detail without referencing parent-only state', async () => {
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    render(<MeetingManagementView />);

    fireEvent.click(await screen.findByText(meeting.name));

    await screen.findByRole('heading', { name: meeting.name });
    expect(screen.getByRole('dialog', { name: 'Detalle de reunión' })).toHaveTextContent('PMC pendiente de vincular');
  });
});
