import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MyWorkView from '../src/ceo-dashboard/views/MyWorkView';

describe('Bandeja personal de tareas', () => {
  it('separa tareas de revisiones e incidencias, incluso cuando ya se leyó la notificación', () => {
    const onOpen = vi.fn();
    render(<MyWorkView onOpen={onOpen} work={{ items: [
      { key: 'task', kind: 'action', title: 'Entregar planos', unread: false },
      { key: 'review', kind: 'review', title: 'Aprobar reunión', unread: true },
      { key: 'issue', kind: 'import_error', title: 'Documento vacío', unread: true },
    ], unread: 2, total: 3 }} />);
    expect(screen.getByText('Entregar planos')).toBeInTheDocument();
    expect(screen.queryByText('Aprobar reunión')).not.toBeInTheDocument();
    expect(screen.queryByText('Documento vacío')).not.toBeInTheDocument();
    expect(screen.getByText('Sin tareas nuevas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Entregar planos/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'task' }));
  });

  it('pagina sin perder tareas más allá de la primera página', () => {
    render(<MyWorkView work={{ items: Array.from({ length: 26 }, (_, index) => ({ key: String(index), kind: 'action', title: `Tarea ${index + 1}` })) }} />);
    expect(screen.getByText('Página 1 de 2')).toBeInTheDocument();
    expect(screen.queryByText('Tarea 26')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByText('Tarea 26')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
  });
});
