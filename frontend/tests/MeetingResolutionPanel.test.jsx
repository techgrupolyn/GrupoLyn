import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/ceo-dashboard/api', () => ({ default: { projectMeetings: { resolution: vi.fn(), resolutionDetail: vi.fn(), linkProjects: vi.fn(), reviewerProjects: vi.fn(), reviewers: vi.fn(), saveReviewers: vi.fn() } } }));
import api from '../src/ceo-dashboard/api';
import MeetingResolutionPanel from '../src/ceo-dashboard/views/MeetingResolutionPanel';

beforeEach(() => {
  vi.resetAllMocks();
  api.projectMeetings.reviewerProjects.mockResolvedValue([{ id: 'obra', name: 'Obra de prueba' }]);
  api.projectMeetings.resolution.mockResolvedValue({ items: [{ id: 'meeting', name: 'Reunión sin obra', unlinked_actions: 1 }], total: 1 });
  api.projectMeetings.resolutionDetail.mockResolvedValue({ id: 'meeting', name: 'Reunión sin obra', actions: [{ id: 'action', title: 'Preparar planos', source_ref: 'Fragmento original' }], noActions: false });
  api.projectMeetings.linkProjects.mockResolvedValue({ ok: true });
  api.projectMeetings.saveReviewers.mockResolvedValue({ ok: true });
  api.projectMeetings.reviewers.mockResolvedValue({ id: 'obra', team: [{ id: 'ana', name: 'Ana', cargoIds: ['low'] }, { id: 'eva', name: 'Eva', cargoIds: ['low'] }], positions: [{ id: 'low', name: 'Delineante', final: false }, { id: 'pmc', name: 'PMC', final: true }], candidates: [{ id: 'pmc-person', name: 'Paula', cargoIds: ['pmc'] }], selection: null, automaticReviewers: {}, snapshot: { issue: 'Sin PMC vinculado en Club LYN.', path: [] } });
});

async function openActions(onSaved = vi.fn()) {
  render(<MeetingResolutionPanel meetingId="meeting" onSaved={onSaved} />);

  await screen.findByRole('button', { name: 'Asignar obra: Preparar planos' });
}

describe('Resolver excepciones conservando el gestor habitual', () => {
  it('permite reintentar la carga fallida desde Acciones sin obra', async () => {
    api.projectMeetings.resolutionDetail.mockRejectedValueOnce(new Error('Servidor ocupado'));
    render(<MeetingResolutionPanel meetingId="meeting" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Servidor ocupado');
    fireEvent.click(screen.getByRole('button', { name: 'Acciones sin obra', exact: true }));
    expect(await screen.findByRole('button', { name: 'Asignar obra: Preparar planos' })).toBeEnabled();
    expect(api.projectMeetings.resolutionDetail).toHaveBeenCalledTimes(2);
  });
  it('mantiene el selector abierto al pulsar la pestaña activa y al actualizar la reunión', async () => {
    const view = render(<MeetingResolutionPanel meetingId="meeting" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Asignar obra: Preparar planos' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar obra: Preparar planos' }), { target: { value: 'prueba' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Obra de prueba' }));
    fireEvent.click(screen.getByRole('button', { name: 'Acciones sin obra', exact: true }));
    view.rerender(<MeetingResolutionPanel meetingId="meeting" onSaved={vi.fn()} linkedProjects={[]} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Buscar obra: Preparar planos' })).toHaveValue('prueba'));
    expect(screen.getByRole('option', { name: 'Obra de prueba' })).toHaveAttribute('aria-selected', 'true');
    expect(api.projectMeetings.resolutionDetail).toHaveBeenCalledTimes(1);
  });
  it('carga solo la reunión abierta y no muestra herramienta ni listado global', async () => {
    await openActions();
    expect(api.projectMeetings.resolutionDetail).toHaveBeenCalledWith('meeting');
    expect(api.projectMeetings.resolution).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Resolver vinculaciones' })).not.toBeInTheDocument();
  });
  it('busca y asigna la obra solamente a la acción abierta, como el responsable', async () => {
    const saved = vi.fn();
    api.projectMeetings.resolutionDetail.mockResolvedValue({ id: 'meeting', actions: [{ id: 'action', title: 'Preparar planos' }, { id: 'other', title: 'Revisar presupuesto' }], noActions: false });
    await openActions(saved);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Motivo de la vinculación')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Asignar obra: Preparar planos' }));
    expect(screen.getByRole('button', { name: 'Guardar obra' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar obra: Preparar planos' }), { target: { value: 'prueba' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Obra de prueba' }));
    expect(api.projectMeetings.linkProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar obra' }));
    await screen.findByText(/Vinculación guardada/);
    expect(api.projectMeetings.linkProjects).toHaveBeenCalledWith('meeting', { actionIds: ['action'], projectId: 'obra', reason: 'Obra asignada manualmente desde la acción en el panel de reunión.' });
    expect(saved).toHaveBeenCalledTimes(1);
  });
  it('conserva la selección cuando el servidor rechaza un cambio', async () => {
    api.projectMeetings.linkProjects.mockRejectedValue(new Error('La selección cambió'));
    await openActions();
    fireEvent.click(screen.getByRole('button', { name: 'Asignar obra: Preparar planos' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Obra de prueba' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar obra' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La selección cambió');
    expect(screen.getByRole('option', { name: 'Obra de prueba' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Guardar obra' })).toBeEnabled();
  });
  it('no permite sustituir el PMC ausente por un candidato global ni reutiliza un respaldo antiguo', async () => {
    const directory = await api.projectMeetings.reviewers();
    api.projectMeetings.reviewers.mockResolvedValue({...directory,selection:{startCargoId:null,reviewers:{},fallbackPmc:{employeeId:'pmc-person',cargoId:'pmc'}}});
    render(<MeetingResolutionPanel meetingId="meeting" linkedProjects={[{ id: 'obra', name: 'Obra de prueba' }]} />);
    await screen.findByRole('button', { name: 'Asignar obra: Preparar planos' });
    fireEvent.click(screen.getByRole('button', { name: 'PMC y revisores' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Obra de prueba' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Obra a revisar'), { target: { value: 'obra' } });
    await screen.findByText(/El último cargo ocupado cierra/);
    expect(screen.queryByLabelText(/PMC de respaldo/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Revisor de Delineante')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Revisor de Delineante'), { target: { value: 'eva' } });
    fireEvent.change(screen.getByLabelText('Motivo de la vinculación'), { target: { value: 'Confirmado por Dirección' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar vinculación' }));
    await screen.findByText(/Vinculación guardada/);
    expect(api.projectMeetings.saveReviewers).toHaveBeenCalledWith('obra',{selection:{startCargoId:null,reviewers:{low:'eva'}},reason:'Confirmado por Dirección'});
  });
  it('permite desempatar revisores que ya ocupan el cargo dentro de la obra', async () => {
    const directory = await api.projectMeetings.reviewers();
    api.projectMeetings.reviewers.mockResolvedValue({...directory,team:[...directory.team,{id:'pmc-person',name:'Paula',cargoIds:['pmc']}],snapshot:{issue:'Más de un revisor para Delineante.',path:[]}});
    render(<MeetingResolutionPanel meetingId="meeting" linkedProjects={[{ id: 'obra', name: 'Obra de prueba' }]} />);
    await screen.findByRole('button', { name: 'Asignar obra: Preparar planos' });
    fireEvent.click(screen.getByRole('button', { name: 'PMC y revisores' }));
    fireEvent.change(screen.getByLabelText('Obra a revisar'), { target: { value: 'obra' } });
    fireEvent.change(await screen.findByLabelText('Revisor de Delineante'), { target: { value: 'eva' } });
    expect(screen.getByText('PMC: Paula · Automático por asignación')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Motivo de la vinculación'), { target: { value: 'Confirmado por Dirección' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar vinculación' }));
    await screen.findByText(/Vinculación guardada/);
    expect(api.projectMeetings.saveReviewers).toHaveBeenCalledWith('obra', { selection: { startCargoId: null, reviewers: { low: 'eva' } }, reason: 'Confirmado por Dirección' });
  });
  it('permite cancelar sin guardar y no reutiliza una selección oculta por la búsqueda', async () => {
    await openActions();
    fireEvent.click(screen.getByRole('button', { name: 'Asignar obra: Preparar planos' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Obra de prueba' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar obra: Preparar planos' }), { target: { value: 'inexistente' } });
    expect(screen.getByText('No hay coincidencias.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar obra' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(api.projectMeetings.linkProjects).not.toHaveBeenCalled();
  });
  it('vincula una reunión sin acciones sin inventar identificadores de acciones', async () => {
    api.projectMeetings.resolutionDetail.mockResolvedValue({ id: 'meeting', name: 'Reunión vacía', actions: [], noActions: true });
    render(<MeetingResolutionPanel meetingId="meeting" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Asignar obra: Reunión vacía' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Obra de prueba' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar obra' }));
    await waitFor(() => expect(api.projectMeetings.linkProjects).toHaveBeenCalledWith('meeting', { actionIds: [], projectId: 'obra', reason: 'Obra asignada manualmente desde el panel de reunión sin acciones.' }));
  });
});
