import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.mocked(api.directory.overview).mockResolvedValue({ employees: [], clients: [], projects: [] });
  vi.mocked(api.meetings.list).mockResolvedValue(emptyList);
  vi.mocked(api.meetings.filterOptions).mockResolvedValue({ pmcs: [] });
  vi.mocked(api.meetings.reanalyzeMissingPmc).mockResolvedValue({ queued: 0 });
  vi.mocked(api.meetings.retag).mockResolvedValue({});
  vi.mocked(api.meetings.get).mockResolvedValue(meeting);
});

describe('MeetingManagementView', () => {
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

    expect(await screen.findByRole('dialog', { name: 'Detalle de reunión' })).toHaveTextContent('PMC a cargo: Pendiente');
  });
});