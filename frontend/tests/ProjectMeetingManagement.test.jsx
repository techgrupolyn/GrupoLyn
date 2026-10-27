import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/ceo-dashboard/api', () => ({ default: { directory: { overview: vi.fn() }, meetings: { list: vi.fn(), get: vi.fn(), filterOptions: vi.fn() }, projectMeetings: { reviewerProjects: vi.fn(), resolutionDetail: vi.fn(), linkProjects: vi.fn(), mode: vi.fn(), list: vi.fn(), get: vi.fn(), workflow: vi.fn(), saveAction: vi.fn(), deleteAction: vi.fn(), escalate: vi.fn(), manageAdditionalResponsible: vi.fn(), removeAdditionalResponsible: vi.fn() } } }));
import api from '../src/ceo-dashboard/api';
import MeetingManagementView from '../src/ceo-dashboard/views/MeetingManagementView';

const branch = { id: 'branch', project_id: 'project', project_name: 'Obra de prueba', cursor: 0, approved: false, can_review: true, snapshot: { path: [{ employeeId: 'drafter', name: 'Ana', cargo: 'Delineante', final: false }], issue: null } };
const detail = { id: 'meeting', name: 'Comité local', status: 'pending', enabled: true, partial_scope: true, branches: [branch], history: [], add_projects: [{ id: 'project', name: 'Obra de prueba' }], directory: [{ id: 'person', name: 'Persona del equipo' }], actions: [{ id: 'action', title: 'Revisar planos', project_id: 'project', project_name: 'Obra de prueba', assignment_origin: 'unassigned', responsible_id: null, due_date: null, can_delete: false, can_escalate: false }] };
beforeEach(() => {
  vi.clearAllMocks();
  api.projectMeetings.mode.mockResolvedValue({ enabled: true, enrolled: true });
  api.projectMeetings.list.mockResolvedValue({ items: [{ id: 'meeting', name: 'Comité local', status: 'pending', actions_count: 1 }], total: 1, page: 1, pageSize: 25, totalPages: 1, options: { projects: [{ id: 'project', nombre: 'Obra de prueba' }], pmcs: ['Paula'], roles: ['Delineante'], contacts: [] }, metrics: { pending: 1, awaiting: 1, unassigned: 1, no_project: 0 } });
  api.projectMeetings.get.mockResolvedValue(structuredClone(detail));
  api.projectMeetings.saveAction.mockResolvedValue({ ok: true });
  api.projectMeetings.deleteAction.mockResolvedValue({ ok: true });
});
async function open() {
  render(<MeetingManagementView />);
  fireEvent.click(await screen.findByText('Comité local'));
  await screen.findByText('Revisar planos');
}
describe('Revisión por obra', () => {
  it('cierra como Delineante sin mostrarlo como PMC ni habilitar borrado', async () => {
    const closing = {...branch,snapshot:{...branch.snapshot,pmcId:null,path:[{employeeId:'drafter',name:'Ana',cargo:'Delineante',final:true}]}};
    api.projectMeetings.get.mockResolvedValue({...detail,branches:[closing],actions:[{...detail.actions[0],responsible_id:'person',due_date:'2026-11-01'}]});
    api.projectMeetings.workflow.mockResolvedValue({ok:true});
    await open();
    expect(screen.getByText('Sin PMC asignado en esta obra')).toBeInTheDocument();
    expect(screen.getByText(/Cierra Ana como Delineante/)).toBeInTheDocument();
    expect(screen.queryByText('PMC a cargo: Ana')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Aprobar definitivamente'}));
    await waitFor(()=>expect(api.projectMeetings.workflow).toHaveBeenCalledWith('meeting',{branch_id:'branch',command:'approve'}));
  });
  it('vincula desde el panel lateral de la fila sin botón global ni permisos de aprobación', async () => {
    api.projectMeetings.mode.mockResolvedValue({ enabled: true, enrolled: true, can_configure_reviewers: true });
    api.projectMeetings.get.mockResolvedValue({ ...detail, resolution_only: true, branches: [], actions: [] });
    api.projectMeetings.reviewerProjects.mockResolvedValue([{ id: 'project', name: 'Obra de prueba' }]);
    api.projectMeetings.resolutionDetail.mockResolvedValue({ id: 'meeting', name: 'Comité local', noActions: false, actions: [{ id: 'action', title: 'Acción sin obra' }] });
    api.projectMeetings.linkProjects.mockResolvedValue({ ok: true });
    render(<MeetingManagementView />);
    fireEvent.click(await screen.findByText('Comité local'));
    const assign = await screen.findByRole('button', { name: 'Asignar obra: Acción sin obra' });
    expect(screen.getByRole('dialog')).toContainElement(assign);
    expect(screen.getByLabelText('Resumen ejecutivo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contraer Decisiones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contraer Información relevante' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contraer Cadena y versiones' })).toBeInTheDocument();
    expect(screen.getByText('Cliente')).toBeInTheDocument();
    expect(assign.closest('#review-actions')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '+ Añadir acción' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolver vinculaciones' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprobar/ })).not.toBeInTheDocument();
    fireEvent.click(assign);
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Resultados de obras: Acción sin obra' })).getByRole('option', { name: 'Obra de prueba' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar obra' }));
    await waitFor(() => expect(api.projectMeetings.linkProjects).toHaveBeenCalledWith('meeting', { actionIds: ['action'], projectId: 'project', reason: 'Obra asignada manualmente desde la acción en el panel de reunión.' }));
  });
  it('conserva el listado habitual sin configuración de revisores, también para administración', async () => {
    api.projectMeetings.mode.mockResolvedValue({ enabled:true,enrolled:true,can_configure_reviewers:true });
    render(<MeetingManagementView />);
    await screen.findByText('Comité local');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByLabelText('Buscar reuniones')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Revisores por obra'})).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Obra a configurar')).not.toBeInTheDocument();
  });
  it('oculta el selector con una sola obra y la aprueba sin selección manual', async () => {
    api.projectMeetings.get.mockResolvedValue({ ...detail, actions: [{ ...detail.actions[0], responsible_id: 'person', due_date: '2026-11-01' }] });
    api.projectMeetings.workflow.mockResolvedValue({ ok: true });
    await open();
    expect(screen.queryByLabelText('Rama de revisión')).toBeNull();
    expect(screen.queryByText('Obra en revisión')).toBeNull();
    expect(screen.getByText('Obra de prueba · 1 acciones de esta obra')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar y enviar' }));
    await waitFor(() => expect(api.projectMeetings.workflow).toHaveBeenCalledWith('meeting', { branch_id: 'branch', command: 'approve' }));
  });
  it('cambia acciones y validaciones con la obra, y aprueba únicamente la rama seleccionada', async () => {
    const first = { ...branch, snapshot: { ...branch.snapshot, path: [{ employeeId: 'person', name: 'PMC', cargo: 'PMC', final: true }] } };
    const second = { ...first, id: 'branch-2', project_id: 'project-2', project_name: 'Otra obra' };
    const fixture = { ...detail, branches: [first, second], add_projects: [...detail.add_projects, { id: 'project-2', name: 'Otra obra' }], actions: [detail.actions[0], { ...detail.actions[0], id: 'action-2', project_id: 'project-2', project_name: 'Otra obra', title: 'Confirmar materiales', responsible_id: 'person', due_date: '2026-11-01' }] };
    api.projectMeetings.get.mockResolvedValue(fixture);
    await open();
    expect(screen.queryByText('Confirmar materiales')).toBeNull();
    expect(screen.getByRole('button', { name: 'Aprobar definitivamente' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rama de revisión'), { target: { value: 'branch-2' } });
    await screen.findByText('Confirmar materiales');
    expect(screen.queryByText('Revisar planos')).toBeNull();
    expect(screen.getByRole('button', { name: 'Aprobar definitivamente' }).disabled).toBe(false);
    api.projectMeetings.workflow.mockResolvedValue({ ok: true });
    api.projectMeetings.get.mockResolvedValue({ ...fixture, branches: [first, { ...second, approved: true, can_review: false }] });
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar definitivamente' }));
    await waitFor(() => expect(api.projectMeetings.workflow).toHaveBeenCalledWith('meeting', { branch_id: 'branch-2', command: 'approve' }));
    await screen.findByText('Esta rama ya está aprobada por el PMC.');
    expect(screen.getByLabelText('Rama de revisión').value).toBe('branch-2');
    expect(screen.queryByRole('button', { name: 'Aprobar definitivamente' })).toBeNull();
  });
  it('devuelve la obra seleccionada con motivo y muestra los errores del servidor', async () => {
    const fixture = { ...detail, branches: [{ ...branch, cursor: 1, snapshot: { ...branch.snapshot, path: [...branch.snapshot.path, { employeeId: 'person', name: 'PMC', cargo: 'PMC', final: true }] } }] };
    api.projectMeetings.get.mockResolvedValue(fixture);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    expect(api.projectMeetings.workflow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirmar devolución' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo de devolución'), { target: { value: 'Confirmar la fecha' } });
    api.projectMeetings.workflow.mockRejectedValue({ body: 'El revisor ha cambiado.' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar devolución' }));
    await waitFor(() => expect(api.projectMeetings.workflow).toHaveBeenCalledWith('meeting', { branch_id: 'branch', command: 'return', reason: 'Confirmar la fecha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El revisor ha cambiado.');
    expect(screen.getByRole('button', { name: 'Confirmar devolución' }).disabled).toBe(false);
  });
  it('conserva la tabla habitual, métricas y filtros sin consultar el directorio global', async () => {
    render(<MeetingManagementView />);
    await screen.findByText('Comité local');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('Gestión de reuniones')).toBeTruthy();
    expect(screen.getByText('Mostrando 1–1 de 1 reuniones')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filtrar por proyecto'), { target: { value: 'project' } });
    await waitFor(() => expect(api.projectMeetings.list).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'project' })));
    fireEvent.click(screen.getByRole('button', { name: 'Mi turno' }));
    await waitFor(() => expect(api.projectMeetings.list).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'mine' })));
    expect(api.directory.overview).not.toHaveBeenCalled();
    expect(api.meetings.list).not.toHaveBeenCalled();
    expect(api.meetings.filterOptions).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reanalizar PMC pendientes' })).toBeNull();
  });
  it('abre desde una notificación y cierra con Escape', async () => {
    const opened = vi.fn();
    render(<MeetingManagementView openMeetingId="meeting" onMeetingOpened={opened} />);
    await screen.findByText('Revisar planos');
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('señala Por asignar, no permite borrar al delineante y no ofrece escalado libre', async () => {
    await open();
    expect(screen.getByText(/Solo se muestra la información de tu ámbito/)).toBeTruthy();
    expect(screen.queryByText('Borrar acción')).toBeNull();
    expect(screen.queryByText('Escalar a Dirección')).toBeNull();
    expect(screen.getByRole('button', { name: 'Aprobar y enviar' }).disabled).toBe(true);
    expect(screen.queryByLabelText('Escalar revisión a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Asignar responsable: sin asignar' }));
    fireEvent.click(screen.getByRole('option', { name: /Persona del equipo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    await waitFor(() => expect(api.projectMeetings.saveAction).toHaveBeenCalledWith('meeting','action', { responsible_id: 'person' }));
  });
  it('exige motivo para borrar y lo envía al servidor', async () => {
    api.projectMeetings.get.mockResolvedValue({ ...detail, actions: [{ ...detail.actions[0], can_delete: true }] });
    await open();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar acción: Revisar planos' }));
    expect(api.projectMeetings.deleteAction).not.toHaveBeenCalled();
    prompt.mockReturnValue('Acción duplicada');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar acción: Revisar planos' }));
    await waitFor(() => expect(api.projectMeetings.deleteAction).toHaveBeenCalledWith('meeting','action','Acción duplicada'));
    vi.restoreAllMocks();
  });
  it('reutiliza las secciones originales y edita la tarjeta compacta sin mostrar formularios nuevos', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Contraer Resumen ejecutivo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Contraer Decisiones' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Contraer Información relevante' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Contraer Cadena y versiones' })).toBeTruthy();
    expect(screen.queryByLabelText('Nombre de la acción')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Nombre de la acción'), { target: { value: 'Confirmar planos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.projectMeetings.saveAction).toHaveBeenCalledWith('meeting', 'action', { title: 'Confirmar planos', due_date: null }));
  });
  it('conserva el buscador de responsables adicionales usando la API protegida', async () => {
    api.projectMeetings.manageAdditionalResponsible.mockResolvedValue({ ok: true });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Añadir responsables adicionales' }));
    fireEvent.click(screen.getByRole('option', { name: /Persona del equipo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    await waitFor(() => expect(api.projectMeetings.manageAdditionalResponsible).toHaveBeenCalledWith('meeting', 'action', { kind: 'employee', id: 'person' }));
  });
  it('no ofrece mutaciones sobre resultados aprobados', async () => {
    api.projectMeetings.get.mockResolvedValue({ ...detail, status: 'approved', actions: [{ ...detail.actions[0], can_delete: true, can_escalate: true }] });
    await open();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar acción' })).toBeNull();
    expect(screen.queryByText('Borrar acción')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aprobar y enviar' })).toBeNull();
  });
});
