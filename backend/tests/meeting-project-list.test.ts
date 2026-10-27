import { describe, expect, it } from 'vitest';
import { projectMeetingList } from '../meeting-project-list.ts';

const meetings = Array.from({ length: 30 }, (_, index) => ({
  id: String(index), name: `Comité ${index}`, status: index < 20 ? 'pending' : 'approved',
  meeting_date: `2026-10-${String(index + 1).padStart(2, '0')}`, updated_at: '',
  projects: [{ id: index % 2 ? 'second' : 'first', nombre: index % 2 ? 'Obra B' : 'Obra A' }],
  pmcs: ['Paula'], roles: ['Delineante'], contact_id: 'client', contact_name: 'María',
  awaiting: index < 5, actions_without_responsible: index < 2 ? 1 : 0,
}));

describe('Listado del gestor por proyectos', () => {
  it('pagina sin ocultar el total y ajusta páginas fuera del rango', () => {
    const first = projectMeetingList(meetings, {});
    expect(first).toMatchObject({ total: 30, pageSize: 25, page: 1, totalPages: 2, metrics: { pending: 20, awaiting: 5, unassigned: 2, no_project: 0 } });
    expect(first.items).toHaveLength(25);
    const last = projectMeetingList(meetings, { page: '99' });
    expect(last.page).toBe(2);
    expect(last.items).toHaveLength(5);
  });
  it('combina filtros de ámbito, turno, fecha y orden sin alterar métricas', () => {
    const result = projectMeetingList(meetings, { projectId: 'first', filter: 'mine', dateFrom: '2026-10-03', sort: 'oldest', role: 'Delineante', pmc: 'Paula', contactId: 'client', q: 'maria' });
    expect(result.items.map((item) => item.id)).toEqual(['2','4']);
    expect(result.metrics.awaiting).toBe(5);
    expect(projectMeetingList(meetings, { filter: 'approved' }).total).toBe(10);
    expect(projectMeetingList(meetings, { recentDays: '7' }, Date.parse('2026-10-30')).total).toBe(8);
  });
  it('solo construye opciones de las reuniones previamente autorizadas', () => {
    const result = projectMeetingList([meetings[0]], { q: 'sin coincidencias' });
    expect(result.total).toBe(0);
    expect(result.options.projects).toEqual([{ id: 'first', nombre: 'Obra A' }]);
    expect(result.options.contacts).toEqual([{ id: 'client', nombre: 'María' }]);
  });
});
