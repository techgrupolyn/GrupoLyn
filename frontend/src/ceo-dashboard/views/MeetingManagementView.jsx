import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import MeetingReviewDrawer from './MeetingReviewDrawer';
import { roleLabel, roleTheme } from '../roleTheme';

const emptyAction = { title: '', project_name: '', responsible: '', due_date: '', estimated_minutes: '', source_ref: '', status: 'pending' };

function formatDate(value) {
  return value ? new Date(value).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function formatMeetingDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : 'Fecha sin identificar';
}

function workflowLabel(stage) {
  return ({ agent: 'Agente', delineante: 'Delineante', pmc: 'PMC', operations: 'Dirección Operaciones', director: 'Director General', edición: 'Edición', asignación: 'Asignación' })[stage] || 'Agente';
}

function meetingKindLabel(kind) {
  return ({ COMITE_OBRA: 'Comité de obra', REUNION_CLIENTE: 'Reunión cliente', MEET: 'Reunión' })[kind] || 'Reunión';
}

function analysisStatusLabel(status) {
  return ({ pending: 'Análisis pendiente', processing: 'Analizando', completed: 'Análisis listo', failed: 'Error de análisis' })[status] || 'Sin análisis';
}

function blockerTone(severity) {
  return severity === 'high' ? 'border-red-300/40 bg-red-300/[0.08] text-[#F2F2F2]' : severity === 'medium' ? 'border-amber-300/40 bg-amber-300/[0.08] text-[#D4D4D4]' : 'border-sky-300/30 bg-sky-300/[0.06] text-[#D4D4D4]';
}
function RolePill({ role }) {
  const theme = roleTheme(role);
  return <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium" style={{ color: theme.text, borderColor: theme.border, backgroundColor: theme.background }}><span className="size-1.5 rounded-full" style={{ backgroundColor: theme.accent }} />{roleLabel(role)}</span>;
}

function WorkflowDots({ stage = 'agent' }) {
  const stages = ['agent', 'delineante', 'pmc', 'operations', 'director'];
  const current = Math.max(stages.indexOf(stage), 0);
  return <div className="flex items-center gap-1">{stages.map((item, index) => <span key={item} title={workflowLabel(item)} className={`size-2 rounded-full ${index <= current ? index === current ? 'bg-amber-300' : 'bg-emerald-300' : 'bg-[#2E2E2E]'}`} />)}</div>;
}

function formatActionDueDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'Sin fecha' : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

function responsibleOptionGroups(directory) {
  const groups = { employees: [], subcontractors: [], clients: [] };
  for (const employee of directory?.employees || []) {
    if (employee.activo === false) continue;
    const roles = Array.isArray(employee.roles) ? employee.roles.filter(Boolean) : [];
    const subcontractorRole = roles.find((role) => roleTheme(role).key === 'subcontrata');
    const name = [employee.nombre, employee.apellido].filter(Boolean).join(' ').trim() || employee.email || employee.numero;
    if (!employee.id || !name) continue;
    const item = { key: `employee:${employee.id}`, kind: 'employee', id: employee.id, name, role: subcontractorRole || roles[0] || 'Empleado' };
    groups[subcontractorRole ? 'subcontractors' : 'employees'].push(item);
  }
  for (const client of directory?.clients || []) {
    if (client.activo === false) continue;
    const name = [client.nombre, client.apellido].filter(Boolean).join(' ').trim() || client.email || client.telefono;
    if (!client.id || !name) continue;
    groups.clients.push({ key: `client:${client.id}`, kind: 'client', id: client.id, name, role: 'Cliente' });
  }
  for (const values of Object.values(groups)) values.sort((left, right) => roleLabel(left.role).localeCompare(roleLabel(right.role), 'es') || left.name.localeCompare(right.name, 'es'));
  return groups;
}

const RESPONSIBLE_GROUP_META = {
  employees: { label: 'Empleados', accent: '#58BDEB', border: 'rgba(88, 189, 235, 0.52)', background: 'rgba(88, 189, 235, 0.12)', text: '#C7F1FF' },
  subcontractors: { label: 'Subcontratas', accent: '#E9C66E', border: 'rgba(233, 198, 110, 0.55)', background: 'rgba(233, 198, 110, 0.13)', text: '#FCEBC0' },
  clients: { label: 'Clientes', accent: '#46CB92', border: 'rgba(70, 203, 146, 0.55)', background: 'rgba(70, 203, 146, 0.13)', text: '#B8F4D4' },
};

function responsibleVisualTheme(action) {
  if (action.responsible_kind === 'client' || String(action.responsible_role || '').toLowerCase() === 'cliente') return RESPONSIBLE_GROUP_META.clients;
  const theme = roleTheme(action.responsible_role);
  return theme.key === 'default' ? RESPONSIBLE_GROUP_META.employees : theme;
}
function normalizeResponsibleSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function responsibleReferenceKey(person) {
  const kind = person?.responsible_kind || person?.kind || (person?.employee_id ? 'employee' : '');
  const id = person?.responsible_id || person?.id || person?.employee_id || '';
  return kind && id ? `${kind}:${id}` : '';
}

export default function MeetingManagementView({ limitedAccess = false, canEdit = !limitedAccess, openMeetingId = '', onMeetingOpened = () => {} }) {
  const [meetings, setMeetings] = useState([]);
  const [directory, setDirectory] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [projectId, setProjectId] = useState('');
  const [pmc, setPmc] = useState('');
  const [detectedPmcs, setDetectedPmcs] = useState([]);
  const [contactId, setContactId] = useState('');
  const [role, setRole] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [recentDays, setRecentDays] = useState('');
  const [customDate, setCustomDate] = useState(false);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [metrics, setMetrics] = useState({ pending: 0, awaiting: 0, unassigned: 0, no_project: 0 });
  const [loading, setLoading] = useState(true);
  const [retagging, setRetagging] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const projects = useMemo(() => [...(directory?.projects || [])].sort((left, right) => String(left.nombre || '').localeCompare(String(right.nombre || ''), 'es')), [directory]);

  const contacts = useMemo(() => [...(directory?.clients || [])].sort((left, right) => [left.nombre, left.apellido].filter(Boolean).join(' ').localeCompare([right.nombre, right.apellido].filter(Boolean).join(' '), 'es')), [directory]);
  const roles = useMemo(() => Array.from(new Set((directory?.employees || []).flatMap((employee) => employee.roles || []).map((item) => String(item || '').trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'es')), [directory]);
  const nameOf = (person) => [person?.nombre, person?.apellido].filter(Boolean).join(' ').trim() || 'Sin nombre';

  const load = async (targetPage = page) => {
    setLoading(true);
    setError('');
    try {
      const [result, options] = await Promise.all([
        api.meetings.list({ page: targetPage, pageSize: 25, q: query, filter, projectId, pmc, contactId, role, dateFrom, dateTo, recentDays, sort }),
        api.meetings.filterOptions().catch(() => null),
      ]);
      setMeetings(result.items || []);
      if (options) {
        setDetectedPmcs(options.pmcs || []);
        if (!canEdit) setDirectory({ employees: (options.roles || []).map((roleName) => ({ roles: [roleName] })), clients: options.contacts || [], projects: options.projects || [] });
      }
      setPagination({ page: result.page || targetPage, pageSize: result.pageSize || 25, total: result.total || 0, totalPages: result.totalPages || 0 });
      setMetrics(result.metrics || { pending: 0, awaiting: 0, unassigned: 0, no_project: 0 });
    } catch (requestError) {
      setError(requestError.body || requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canEdit) {
      void api.directory.overview().then((result) => setDirectory(result || null)).catch(() => setDirectory({ employees: [], clients: [], projects: [] }));
    }
    void api.meetings.filterOptions().then((result) => {
      setDetectedPmcs(result?.pmcs || []);
      if (!canEdit) setDirectory({ employees: (result?.roles || []).map((roleName) => ({ roles: [roleName] })), clients: result?.contacts || [], projects: result?.projects || [] });
    }).catch(() => {
      setDetectedPmcs([]);
      if (limitedAccess) setDirectory({ employees: [], clients: [], projects: [] });
    });
  }, [limitedAccess, canEdit]);
  useEffect(() => {
    void load(page);
    const timer = window.setInterval(() => { void load(page); }, 15_000);
    return () => window.clearInterval(timer);
  }, [page, query, filter, projectId, pmc, contactId, role, dateFrom, dateTo, recentDays, sort]);
  useEffect(() => {
    if (!openMeetingId) return undefined;
    let active = true;
    void api.meetings.get(openMeetingId).then((result) => { if (active) setSelected(result); }).catch((requestError) => { if (active) setError(requestError.body || requestError.message); }).finally(() => { if (active) onMeetingOpened(); });
    return () => { active = false; };
  }, [openMeetingId, onMeetingOpened]);
  useEffect(() => {
    if (!selected?.id) return undefined;
    const timer = window.setInterval(() => { void api.meetings.get(selected.id).then(setSelected).catch(() => undefined); }, 15_000);
    return () => window.clearInterval(timer);
  }, [selected?.id]);

  const open = async (id) => { try { setSelected(await api.meetings.get(id)); } catch (requestError) { setError(requestError.message); } };
  const refreshSelected = async (id) => { const detail = await api.meetings.get(id); setSelected(detail); await load(); };
  const retag = async () => { setRetagging(true); setError(''); setNotice(''); try { await api.meetings.retag(); await load(); if (selected?.id) setSelected(await api.meetings.get(selected.id)); } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudieron vincular las reuniones con el directorio.'); } finally { setRetagging(false); } };
  const reanalyzeMissingPmc = async () => {
    if (!window.confirm('Se reenviarán a IA únicamente las reuniones con PMC pendiente de extraer. El procesamiento será gradual para controlar el coste. ¿Continuar?')) return;
    setRequeueing(true); setError(''); setNotice('');
    try {
      const result = await api.meetings.reanalyzeMissingPmc();
      setNotice(result?.queued ? `${result.queued} reuniones sin PMC se encolaron para análisis.` : 'No hay reuniones con PMC pendiente de extraer.');
      await load();
    } catch (requestError) {
      setError(requestError.body || requestError.message || 'No se pudieron reenviar las reuniones sin PMC.');
    } finally {
      setRequeueing(false);
    }
  };
  const clearFilters = () => { setProjectId(''); setPmc(''); setContactId(''); setRole(''); setDateFrom(''); setDateTo(''); setRecentDays(''); setCustomDate(false); setSort('recent'); setPage(1); };
  const filtersActive = Boolean(projectId || pmc || contactId || role || dateFrom || dateTo || recentDays || customDate || sort !== 'recent');
  const pageStart = pagination.total ? ((pagination.page - 1) * pagination.pageSize) + 1 : 0;
  const pageEnd = pagination.total ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;

  return <section className="ceo-page p-4 sm:p-6 xl:p-8">
    <div className="mb-5 flex flex-col gap-3 border-b border-[#2E2E2E] pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#737373]">Agente de reuniones</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-[#F2F2F2]">Gestión de reuniones</h2><p className="mt-1 text-xs text-[#737373]">{limitedAccess ? 'Estas son las reuniones donde estás vinculado como responsable, PMC o miembro del proyecto.' : 'Revisá y aprobá los borradores operativos importados desde Google Drive.'}</p></div>
      <div className="flex flex-wrap gap-2"><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Buscar contacto, teléfono, email u obra…" className="h-9 w-72 max-w-full ceo-surface rounded border border-[#2E2E2E] bg-[#141414] px-3 text-xs text-[#F2F2F2] outline-none" /><button type="button" onClick={reanalyzeMissingPmc} disabled={limitedAccess || requeueing} className="h-9 rounded border border-amber-300/35 bg-amber-300/[0.08] px-3 text-xs font-medium text-amber-100 hover:border-amber-300 disabled:opacity-40">{requeueing ? 'Encolando PMC…' : 'Reanalizar PMC pendientes'}</button><button type="button" onClick={retag} disabled={limitedAccess || retagging} className="h-9 rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-3 text-xs font-medium text-emerald-100 hover:border-emerald-300 disabled:opacity-40">{retagging ? 'Vinculando…' : 'Vincular directorio'}</button></div>
    </div>
    {limitedAccess && <p className="mb-4 rounded border border-sky-300/30 bg-sky-300/[.06] p-3 text-xs text-sky-100">Acceso de lectura: sólo se muestran reuniones vinculadas a ti. La sincronización de Google Drive es central y está disponible para todos los usuarios autorizados.</p>}{error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded border border-sky-300/30 bg-sky-300/[0.08] p-3 text-xs text-sky-100">{notice}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[{ label: 'En cadena de revisión', value: Number(metrics.pending || 0) }, { label: 'Esperan tu revisión', value: Number(metrics.awaiting || 0) }, { label: 'Acciones sin responsable vinculado', value: Number(metrics.unassigned || 0) }, { label: 'Sin obra vinculada', value: Number(metrics.no_project || 0) }].map((metric) => <div key={metric.label} className="dashboard-metric-card rounded-md border border-[#2E2E2E] bg-[#141414] p-4"><p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]">{metric.label}</p><p className="mt-1 text-2xl font-semibold text-[#F2F2F2]">{metric.value}</p></div>)}</div>
    <div className="mt-5 overflow-hidden rounded-md border border-[#2E2E2E] bg-[#141414]">
      <div className="border-b border-[#2E2E2E] px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[['all', 'Todo'], ['mine', 'Mi turno'], ['pending', 'Pendientes'], ['approved', 'Aprobadas']].map(([key, label]) => <button key={key} type="button" onClick={() => { setFilter(key); setPage(1); }} className={`dashboard-filter-tab rounded px-3 py-1.5 text-xs ${filter === key ? 'is-active bg-[#2E2E2E] text-[#F2F2F2]' : 'text-[#737373]'}`}>{label}</button>)}
          <span className="mx-1 hidden h-6 w-px bg-[#2E2E2E] sm:block" />
          <select aria-label="Filtrar por proyecto" value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }} className="h-8 max-w-52 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-amber-300/50"><option value="">Proyecto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.nombre}</option>)}</select>
          <select aria-label="Filtrar por PMC detectado" value={pmc} onChange={(event) => { setPmc(event.target.value); setPage(1); }} className="h-8 max-w-52 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-sky-300/50"><option value="">PMC detectado</option>{detectedPmcs.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <select aria-label="Filtrar por rol" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} className="h-8 max-w-48 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-violet-300/50"><option value="">Rol</option>{roles.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}</select>
          <select aria-label="Filtrar por contacto" value={contactId} onChange={(event) => { setContactId(event.target.value); setPage(1); }} className="h-8 max-w-52 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-emerald-300/50"><option value="">Contacto</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{nameOf(contact)}</option>)}</select>
          <span className="mx-1 hidden h-6 w-px bg-[#2E2E2E] md:block" />
          <select aria-label="Filtrar por fecha" value={customDate ? 'custom' : recentDays} onChange={(event) => { const value = event.target.value; setCustomDate(value === 'custom'); setRecentDays(value === 'custom' ? '' : value); if (value !== 'custom') { setDateFrom(''); setDateTo(''); } setPage(1); }} className="h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-sky-300/50"><option value="">Fecha</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="custom">Rango de fechas…</option></select>
          <select aria-label="Ordenar reuniones" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }} className="h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-sky-300/50"><option value="recent">Más recientes</option><option value="oldest">Más antiguas</option></select>
          <button type="button" onClick={clearFilters} disabled={!filtersActive} className="h-8 rounded border border-transparent px-2 text-xs text-[#737373] hover:border-[#2E2E2E] hover:text-[#F2F2F2] disabled:opacity-40">Limpiar</button>
        </div>
        {customDate && <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-[#2E2E2E] pt-3"><label className="text-[10px] text-[#737373]">Desde<input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} className="ml-2 h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#F2F2F2] outline-none" /></label><label className="text-[10px] text-[#737373]">Hasta<input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} className="ml-2 h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#F2F2F2] outline-none" /></label></div>}
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-left"><thead className="bg-[#0D0D0D] font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]"><tr><th className="px-3 py-3">Reunión</th><th className="px-3 py-3">Obra / PMC a cargo</th><th className="px-3 py-3">Contacto</th><th className="px-3 py-3">Acciones</th><th className="px-3 py-3">Cadena de revisión</th><th className="px-3 py-3">Estado</th></tr></thead><tbody className="divide-y divide-[#2E2E2E]">{meetings.map((meeting) => <tr key={meeting.id} onClick={() => open(meeting.id)} className="group cursor-pointer hover:bg-[#0D0D0D]"><td className="border-l-2 border-l-transparent px-3 py-3 group-hover:border-l-sky-300"><p className="font-medium text-[#F2F2F2]">{meeting.name}</p><p className="mt-1 text-[11px] text-[#737373]">{formatMeetingDate(meeting.meeting_date)} · {meetingKindLabel(meeting.meeting_kind)}</p></td><td className="px-3 py-3 text-xs text-[#F2F2F2]"><p>{meeting.project_name || 'Obra pendiente de identificar'}</p><div className={`mt-1 flex flex-wrap items-center gap-1.5 text-[11px] ${meeting.pmc ? 'text-[#BFBFBF]' : 'text-amber-200'}`}><span>PMC a cargo: {meeting.pmc || 'Pendiente de extraer de la reunión'}{meeting.pmc_employee_id && <span className="ml-1 text-emerald-200">✓</span>}</span>{meeting.pmc_role && <RolePill role={meeting.pmc_role} />}</div></td><td className="px-3 py-3 text-xs text-[#BFBFBF]"><p>{meeting.contact_name || '—'}</p>{meeting.contact_id && <p className="mt-1 text-[10px] text-emerald-200">✓ Cliente vinculado</p>}</td><td className="px-3 py-3 text-xs text-[#F2F2F2]">{meeting.actions_count || 0} acciones<p className="mt-1 text-[11px] text-[#737373]">{meeting.actions_without_responsible || 0} sin responsable · {meeting.actions_without_due_date || 0} sin fecha</p></td><td className="px-3 py-3"><WorkflowDots stage={meeting.workflow_stage} /><p className="mt-1 text-[11px] text-[#BFBFBF]">{workflowLabel(meeting.workflow_stage)}</p></td><td className="px-3 py-3 text-xs text-[#BFBFBF]"><p>{meeting.status === 'approved' ? 'Aprobada' : meeting.status === 'returned' ? 'Devuelta' : meeting.status === 'pending' ? 'En revisión' : 'Borrador'}</p><p className="mt-1 text-[10px] text-[#737373]">{analysisStatusLabel(meeting.analysis_status)}</p></td></tr>)}{!loading && !meetings.length && <tr><td colSpan="6" className="px-3 py-12 text-center text-xs text-[#737373]">No hay reuniones que coincidan con los filtros.</td></tr>}</tbody></table></div>
      <div className="flex flex-col gap-3 border-t border-[#2E2E2E] px-3 py-3 text-xs text-[#737373] sm:flex-row sm:items-center sm:justify-between"><p>Mostrando {pageStart}–{pageEnd} de {pagination.total} reuniones</p><div className="flex items-center gap-2"><button type="button" disabled={pagination.page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[#BFBFBF] hover:border-sky-300/50 disabled:cursor-not-allowed disabled:opacity-40">Anterior</button><span className="min-w-24 text-center">Página {pagination.page} de {Math.max(1, pagination.totalPages)}</span><button type="button" disabled={!pagination.totalPages || pagination.page >= pagination.totalPages || loading} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[#BFBFBF] hover:border-sky-300/50 disabled:cursor-not-allowed disabled:opacity-40">Siguiente</button></div></div>
    </div>
    {selected && <><button type="button" aria-label="Cerrar detalle" onClick={() => setSelected(null)} className="fixed inset-0 z-40 bg-black/60" /><MeetingReviewDrawer meeting={selected} directory={directory} readOnly={!canEdit} onClose={() => setSelected(null)} onChanged={refreshSelected} /></>}
  </section>;
}