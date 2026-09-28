import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MeetingReviewDrawer, { actionResponsibleReferences } from '../src/ceo-dashboard/views/MeetingReviewDrawer';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { meetings: { recordingNotice: vi.fn(), update: vi.fn(), workflow: vi.fn() } } }));

const meeting = {
  id: 'qa-meeting', name: 'Comité QA', summary: 'Resumen actual', decisions: 'Decisión actual',
  relevant_information: 'Sanitarios: subida del 5 %', analysis_status: 'completed',
  actions: [], versions: [], blockers: { missingResponsible: 0, missingDueDate: 0 },
};

describe('QA del panel lateral', () => {
  it('guarda cambios del resumen desde el botón principal sin aprobar la reunión', async () => {
    const onChanged = vi.fn();
    api.meetings.update.mockResolvedValue({ ok: true });
    render(<MeetingReviewDrawer meeting={meeting} onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.change(screen.getByDisplayValue('Resumen actual'), { target: { value: 'Resumen editado' } });
    const save = screen.getByRole('button', { name: 'Guardar borrador' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(meeting.id));
    expect(api.meetings.update).toHaveBeenCalledWith(meeting.id, expect.objectContaining({ summary: 'Resumen editado' }));
    expect(api.meetings.workflow).not.toHaveBeenCalled();
  });

  it('mantiene la edición y muestra el error cuando falla el guardado', async () => {
    api.meetings.update.mockRejectedValue(new Error('Guardado rechazado'));
    const onChanged = vi.fn();
    render(<MeetingReviewDrawer meeting={meeting} onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.change(screen.getByDisplayValue('Resumen actual'), { target: { value: 'Resumen pendiente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    expect(await screen.findByText('Guardado rechazado')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Resumen pendiente')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('N-01: normaliza datos antiguos sin duplicar al principal ni a los adicionales', () => {
    const primary = { responsible_kind: 'employee', responsible_id: 'one', name: 'Alan' };
    const extra = { responsible_kind: 'client', responsible_id: 'two', name: 'Cliente' };
    expect(actionResponsibleReferences({ responsible_id: 'one', responsibles: [primary, extra, extra] })).toEqual({ primaryKey: 'employee:one', additional: [extra] });
    expect(actionResponsibleReferences({ responsible_kind: 'client', responsible_id: 'two', responsibles: [primary, extra] }).additional).toEqual([primary]);
    expect(actionResponsibleReferences({ responsibles: [primary] }).additional).toEqual([primary]);
  });

  it('N-01: una única persona primaria no muestra Ver 1', () => {
    const action = { id: 'single', title: 'Acción con Alan', status: 'pending', responsible: 'Alan', responsible_id: 'one', responsibles: [{ responsible_kind: 'employee', responsible_id: 'one', name: 'Alan' }] };
    render(<MeetingReviewDrawer meeting={{ ...meeting, actions: [action] }} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Ver 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir acción: Acción con Alan' }));
    expect(screen.getByText('Sin responsables adicionales.')).toBeInTheDocument();
  });
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])('muestra la resolución de incidencias en lectura=%s', (readOnly) => {
    render(<MeetingReviewDrawer meeting={{ ...meeting, detected_blockers: [{id:'risk-qa',title:'Entrega demorada',resolved:true,resolution_note:'Entrega confirmada',resolved_by:'Director QA'}] }} readOnly={readOnly} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText('Resuelto')).toBeInTheDocument();
    expect(screen.getByText('Entrega confirmada · Director QA')).toBeInTheDocument();
  });

  it('P-02: permite registrar opcionalmente un aviso real, sin exigirlo para analizar', async () => {
    const onChanged = vi.fn();
    api.meetings.recordingNotice.mockResolvedValue({ ok: true });
    render(<MeetingReviewDrawer meeting={meeting} onClose={vi.fn()} onChanged={onChanged} />);
    expect(screen.getByText(/Este registro no condiciona el análisis automático/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Registro opcional del aviso en Meet'));
    const confirm = await screen.findByRole('checkbox', { name: /Confirmo que el aviso/ });
    expect(confirm).not.toBeChecked();
    expect(confirm).toBeRequired();
    expect(api.meetings.recordingNotice).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Fecha y hora reales del aviso'), { target: { value: '2026-09-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Referencia del aviso'), { target: { value: 'Organizador QA, minuto 00:10' } });
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Registrar aviso realizado en Meet' }));
    expect(api.meetings.recordingNotice).toHaveBeenCalledWith(meeting.id, { confirmed: true, occurred_at: new Date('2026-09-01T10:00').toISOString(), evidence: 'Organizador QA, minuto 00:10' });
    await screen.findByRole('button', { name: 'Registrar aviso realizado en Meet' });
    expect(onChanged).toHaveBeenCalledWith(meeting.id);
  });

  it('no permite registrar avisos con acceso de lectura', async () => {
    render(<MeetingReviewDrawer meeting={meeting} readOnly onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByText('Registro opcional del aviso en Meet')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(api.meetings.recordingNotice).not.toHaveBeenCalled();
  });

  it('muestra el aviso registrado sin permitir sobrescribirlo ni afirmar verificación automática', async () => {
    render(<MeetingReviewDrawer meeting={{ ...meeting, recording_notice: { actor_name: 'Organizador QA', occurred_at: '2026-09-01T10:00:00Z', evidence: 'Referencia verificable QA' } }} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Referencia verificable QA')).toBeInTheDocument();
    expect(screen.getByText('Confirmación del usuario, no verificación automática de Meet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registrar aviso realizado en Meet' })).not.toBeInTheDocument();
  });

  it('M-02: muestra información relevante también con acceso de lectura', async () => {
    render(<MeetingReviewDrawer meeting={meeting} readOnly onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Sanitarios: subida del 5 %')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Añadir acción/ })).not.toBeInTheDocument();
  });

  it('M-04: permite abrir contenido histórico sin sustituir la versión actual', async () => {
    const version = { id: 'qa-version', actor: 'Revisor QA', stage: 'pmc', detail: 'Cambio de acción', created_at: '2026-09-27T12:00:00Z', snapshot: { meeting: { summary: 'Resumen histórico' }, actions: [{ id: 'qa-action', title: 'Acción histórica', responsible: 'Persona QA' }], blockers: [] } };
    render(<MeetingReviewDrawer meeting={{ ...meeting, versions: [version] }} readOnly onClose={vi.fn()} onChanged={vi.fn()} />);
    const open = await screen.findByText('Ver contenido de esta versión');
    fireEvent.click(open);
    expect(open.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Resumen actual')).toBeInTheDocument();
    expect(screen.getByText(/Resumen histórico/)).toBeInTheDocument();
    expect(screen.getByText('Acción histórica')).toBeInTheDocument();
  });

  it('no inventa copias de versiones anteriores a la migración', async () => {
    render(<MeetingReviewDrawer meeting={{ ...meeting, versions: [{ id: 'old', actor: 'QA', stage: 'pmc' }] }} readOnly onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Versión histórica sin copia de contenido.')).toBeInTheDocument();
  });

  it('B-05: señala Sin obra con advertencia, no como identificación exitosa', async () => {
    render(<MeetingReviewDrawer meeting={meeting} readOnly onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Sin obra')).toHaveClass('text-amber-100');
  });
});
