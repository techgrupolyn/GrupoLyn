type Project = { id: string; nombre: string };
export type ScopedMeeting = {
  id: string; name: string; status: string; meeting_date: string | null; updated_at: string;
  projects: Project[]; pmcs: string[]; roles: string[]; contact_id: string | null; contact_name: string | null;
  awaiting: boolean; actions_without_responsible: number;
};

export function projectMeetingList<Meeting extends ScopedMeeting>(meetings: Meeting[], query: Record<string, unknown>, now = Date.now()) {
  const value = (key: string) => typeof query[key] === 'string' ? String(query[key]).trim() : '';
  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const unique = (values: string[]) => [...new Set(values)].sort((left, right) => left.localeCompare(right, 'es'));
  const options = {
    projects: [...new Map(meetings.flatMap((meeting) => meeting.projects).map((project) => [project.id, project])).values()],
    pmcs: unique(meetings.flatMap((meeting) => meeting.pmcs)),
    roles: unique(meetings.flatMap((meeting) => meeting.roles)),
    contacts: [...new Map(meetings.filter((meeting) => meeting.contact_id).map((meeting) => [meeting.contact_id, { id: meeting.contact_id, nombre: meeting.contact_name }])).values()],
  };
  const metrics = {
    pending: meetings.filter((meeting) => meeting.status !== 'approved').length,
    awaiting: meetings.filter((meeting) => meeting.awaiting).length,
    unassigned: meetings.reduce((total, meeting) => total + meeting.actions_without_responsible, 0),
    no_project: meetings.filter((meeting) => !meeting.projects.some((project) => project.id)).length,
  };
  const recentDays = Number(value('recentDays'));
  const filtered = meetings.filter((meeting) => {
    const date = String(meeting.meeting_date || '').slice(0, 10);
    if (value('q') && !normalize([meeting.name, meeting.contact_name, ...meeting.projects.map((project) => project.nombre), ...meeting.pmcs].join(' ')).includes(normalize(value('q')))) return false;
    if (value('projectId') && !meeting.projects.some((project) => project.id === value('projectId'))) return false;
    if (value('pmc') && !meeting.pmcs.includes(value('pmc'))) return false;
    if (value('role') && !meeting.roles.includes(value('role'))) return false;
    if (value('contactId') && meeting.contact_id !== value('contactId')) return false;
    if (value('filter') === 'mine' && !meeting.awaiting) return false;
    if (value('filter') === 'pending' && meeting.status === 'approved') return false;
    if (value('filter') === 'approved' && meeting.status !== 'approved') return false;
    if (value('dateFrom') && (!date || date < value('dateFrom'))) return false;
    if (value('dateTo') && (!date || date > value('dateTo'))) return false;
    if (recentDays > 0 && (!date || Date.parse(date) < now - recentDays * 86400000)) return false;
    return true;
  });
  filtered.sort((left, right) => {
    const comparison = String(left.meeting_date || left.updated_at).localeCompare(String(right.meeting_date || right.updated_at)) || left.id.localeCompare(right.id);
    return value('sort') === 'oldest' ? comparison : -comparison;
  });
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(value('pageSize')) || 25)));
  const totalPages = Math.ceil(filtered.length / pageSize);
  const page = Math.min(Math.max(1, Math.floor(Number(value('page')) || 1)), Math.max(1, totalPages));
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize, totalPages, metrics, options };
}
