import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MeetingImportIssue from '../src/ceo-dashboard/components/MeetingImportIssue';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { directory: { overview: vi.fn() }, meetings: { setOrganizer: vi.fn(), detectOrganizer: vi.fn() } } }));

const issue = { artifactId: 'empty-qa', title: 'Documento sin texto', meetingName: 'Reunión QA', detail: 'No se pudo extraer texto.' };

describe('Incidencias de importación de reuniones', () => {
  it('explica cuándo Calendar no puede identificar al organizador sin inventarlo', async () => {
    api.directory.overview.mockResolvedValue({ employees: [] });
    api.meetings.detectOrganizer.mockResolvedValue({ linked: false, reason: 'No hay evento único.' });
    render(<MeetingImportIssue issue={issue} canAssign onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detectar organizador en Calendar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No hay evento único.');
    expect(api.meetings.setOrganizer).not.toHaveBeenCalled();
  });
  beforeEach(() => vi.clearAllMocks());

  it('muestra la incidencia sin solicitar el directorio para un usuario de lectura', () => {
    render(<MeetingImportIssue issue={issue} canAssign={false} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(issue.detail)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(api.directory.overview).not.toHaveBeenCalled();
  });

  it('vincula solo al organizador seleccionado, sin asumir que sea el dueño de Drive', async () => {
    api.directory.overview.mockResolvedValue({ employees: [{ id: 'active', nombre: 'Persona QA', activo: true }, { id: 'inactive', nombre: 'Inactivo QA', activo: false }] });
    api.meetings.setOrganizer.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(<MeetingImportIssue issue={issue} canAssign onClose={onClose} onChanged={onChanged} />);
    await screen.findByRole('option', { name: 'Persona QA' });
    expect(screen.queryByRole('option', { name: 'Inactivo QA' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(api.meetings.setOrganizer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular y notificar' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.meetings.setOrganizer).toHaveBeenCalledWith(issue.artifactId, 'active');
    expect(onChanged).toHaveBeenCalled();
  });

  it('conserva la incidencia abierta y muestra el fallo si no se pudo vincular', async () => {
    api.directory.overview.mockResolvedValue({ employees: [{ id: 'active', nombre: 'Persona QA' }] });
    api.meetings.setOrganizer.mockRejectedValue(new Error('No se pudo guardar'));
    const onClose = vi.fn();
    render(<MeetingImportIssue issue={issue} canAssign onClose={onClose} onChanged={vi.fn()} />);
    await screen.findByRole('option', { name: 'Persona QA' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular y notificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar');
    expect(onClose).not.toHaveBeenCalled();
  });
});
