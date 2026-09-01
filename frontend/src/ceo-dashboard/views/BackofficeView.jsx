import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { highlightedRoleThemes, primaryRole, roleLabel, roleTheme } from '../roleTheme';

const panelClass = 'ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-5';
const tabClass = 'rounded-md border px-3 py-2 text-xs font-medium transition-colors';

function fullName(person) {
  return [person?.nombre, person?.apellido].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

function formatDate(value, withTime = false) {
  if (!value) return 'No disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No disponible';
  return date.toLocaleString('es-ES', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

function RoleBadge({ role, compact = false }) {
  const theme = roleTheme(role);
  return <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'}`} style={{ color: theme.text, borderColor: theme.border, backgroundColor: theme.background }}><span className="size-1.5 rounded-full" style={{ backgroundColor: theme.accent }} />{roleLabel(role)}</span>;
}

function Field({ label, value }) {
  return <div className="min-w-0 rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2"><p className="text-[10px] uppercase tracking-[0.16em] text-[#737373]">{label}</p><p className="mt-1 break-words text-xs text-[#E8E8E8]">{value || 'No disponible'}</p></div>;
}

function RoleSummary({ employees }) {
  return <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{highlightedRoleThemes.map((theme) => {
    const count = employees.filter((employee) => (employee.roles || []).some((role) => roleTheme(role).key === theme.key)).length;
    return <div key={theme.key} className="rounded-md border bg-[#111111] p-4 transition-colors hover:bg-[#151515]" style={{ borderColor: theme.border }}><p className="text-xs text-[#A6A6A6]">{theme.label}s</p><p className="mt-1 text-2xl font-semibold" style={{ color: theme.text }}>{count}</p><div className="mt-2"><RoleBadge role={theme.label} /></div></div>;
  })}</div>;
}

function DirectoryPanel({ directory, syncing, error, onSync }) {
  const employees = directory?.employees || [];
  const clients = directory?.clients || [];
  const projects = directory?.projects || [];
  const lastSync = directory?.lastSync;
  const syncDate = formatDate(lastSync?.finished_at || lastSync?.started_at, true);
  return <section className={panelClass}><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#8FC7E8]">Directorio empresarial</p><h3 className="mt-1 text-base font-medium text-[#F2F2F2]">Datos centralizados y listos para reuniones</h3><p className="mt-1 text-xs text-[#737373]">El origen se consulta en modo lectura y la copia operativa queda en esta base de datos.</p></div><button type="button" onClick={onSync} disabled={syncing || !directory?.configured} className="ceo-button-primary rounded-md bg-[#8FC7E8] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-[#0D0D0D] disabled:cursor-not-allowed disabled:opacity-40">{syncing ? 'Sincronizando...' : 'Sincronizar ahora'}</button></div><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Empleados', employees.length, '#8FC7E8'], ['Clientes', clients.length, '#B9D989'], ['Proyectos', projects.length, '#F2B66D'], ['Asignaciones', projects.reduce((total, project) => total + (project.asignaciones?.length || 0), 0), '#D8A3E6']].map(([label, value, color]) => <div key={label} className="ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-3"><p className="text-[10px] uppercase tracking-[0.18em] text-[#737373]">{label}</p><p className="mt-1 text-2xl font-semibold" style={{ color }}>{value}</p></div>)}</div><RoleSummary employees={employees} /><p className="mt-4 text-xs text-[#737373]">Última sincronización: <strong className="font-medium text-[#CFCFCF]">{syncDate}</strong>{lastSync?.status && <> · <span className={lastSync.status === 'success' ? 'text-emerald-300' : 'text-red-300'}>{lastSync.status === 'success' ? 'Correcta' : 'Con error'}</span></>}</p>{error && <p className="mt-3 text-xs text-red-300">{error}</p>}</section>;
}

function EmployeeDetail({ employee }) {
  return <div className="space-y-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Nombre" value={fullName(employee)} /><Field label="Correo" value={employee.email} /><Field label="Teléfono" value={employee.numero} /><Field label="Empresa" value={employee.empresa} /><Field label="Estado" value={employee.activo ? 'Activo' : 'Inactivo'} /><Field label="Actualizado en origen" value={formatDate(employee.source_updated_at, true)} /><Field label="Sincronizado" value={formatDate(employee.synced_at, true)} /></div><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#737373]">Roles</p><div className="mt-2 flex flex-wrap gap-1.5">{(employee.roles || []).map((role) => <RoleBadge key={role} role={role} />)}{!employee.roles?.length && <RoleBadge role={null} />}</div></div></div>;
}

function ClientDetail({ client }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Nombre" value={fullName(client)} /><Field label="Correo" value={client.email} /><Field label="Teléfono" value={client.telefono} /><Field label="Estado" value={client.activo ? 'Activo' : 'Inactivo'} /><Field label="Actualizado en origen" value={formatDate(client.source_updated_at, true)} /><Field label="Sincronizado" value={formatDate(client.synced_at, true)} /></div>;
}

function ProjectDetail({ project, onCreateAlias, onDeleteAlias }) {
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saveAlias = async (event) => {
    event.preventDefault();
    const value = alias.trim();
    if (!value) return;
    setBusy(true); setError('');
    try { await onCreateAlias(project.id, value); setAlias(''); } catch (saveError) { setError(String(saveError?.message || 'No se pudo guardar el alias.')); } finally { setBusy(false); }
  };
  const removeAlias = async (aliasId) => {
    setBusy(true); setError('');
    try { await onDeleteAlias(project.id, aliasId); } catch (removeError) { setError(String(removeError?.message || 'No se pudo eliminar el alias.')); } finally { setBusy(false); }
  };
  return <div className="space-y-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Proyecto" value={project.nombre} /><Field label="Estado" value={project.estado} /><Field label="Cliente" value={project.cliente_nombre} /><Field label="Interiorista" value={project.interiorista_nombre} /><Field label="Correo de cliente" value={project.cliente_email} /><Field label="Teléfono de cliente" value={project.cliente_telefono} /><Field label="Correo de interiorista" value={project.interiorista_email} /><Field label="Ciudad" value={project.ciudad} /><Field label="Dirección" value={project.direccion} /><Field label="Fecha de inicio" value={formatDate(project.fecha_inicio)} /><Field label="Fin estimado" value={formatDate(project.fecha_fin_estimada)} /><Field label="Fin real" value={formatDate(project.fecha_fin_real)} /><Field label="Activo" value={project.activo ? 'Sí' : 'No'} /><Field label="Sincronizado" value={formatDate(project.synced_at, true)} /></div><Field label="Descripción" value={project.descripcion} /><section className="rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#F2B66D]">Alias de identificación</p><p className="mt-1 text-[11px] text-[#737373]">Nombres históricos, de cliente o de fase. Se usan solo para este proyecto.</p></div><span className="rounded border border-[#2E2E2E] px-2 py-1 text-[10px] text-[#BFBFBF]">{project.aliases?.length || 0}</span></div><div className="mt-3 flex flex-wrap gap-2">{project.aliases?.map((entry) => <span key={entry.id} className="inline-flex items-center gap-1.5 rounded border border-[#F2B66D]/35 bg-[#F2B66D]/[0.08] px-2 py-1 text-[10px] text-[#FBE4BF]">{entry.alias}<button type="button" disabled={busy} onClick={() => removeAlias(entry.id)} className="text-[#D8A45F] hover:text-red-300 disabled:opacity-50">×</button></span>)}{!project.aliases?.length && <p className="text-xs text-[#737373]">Sin alias configurados.</p>}</div><form onSubmit={saveAlias} className="mt-3 flex gap-2"><input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength="255" placeholder="Ej. Proyecto María Jesús e Ignacio" className="h-9 min-w-0 flex-1 rounded border border-[#2E2E2E] bg-[#141414] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" /><button disabled={busy || !alias.trim()} className="rounded border border-[#F2B66D]/50 px-3 text-xs font-medium text-[#FBE4BF] hover:bg-[#F2B66D]/10 disabled:opacity-50">{busy ? 'Guardando…' : 'Añadir alias'}</button></form>{error && <p className="mt-2 text-xs text-red-300">{error}</p>}</section><div><p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#737373]">Responsables asignados</p><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{project.asignaciones?.map((assignment) => { const theme = roleTheme(assignment.rol); return <div key={assignment.id} className="rounded-md border bg-[#101010] px-3 py-2" style={{ borderColor: theme.border }}><p className="text-xs font-medium text-[#E8F4FA]">{assignment.nombre}</p><div className="mt-1"><RoleBadge role={assignment.rol} compact /></div><p className="mt-1 break-words text-[11px] text-[#737373]">{assignment.email || assignment.telefono || 'Sin contacto'}</p></div>; })}{!project.asignaciones?.length && <p className="text-xs text-[#737373]">No hay responsables asignados.</p>}</div></div></div>;
}

function DirectoryViews({ directory, onCreateAlias, onDeleteAlias }) {
  const [activeTab, setActiveTab] = useState('employees');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const allEmployees = directory?.employees || [];
  const subcontractors = allEmployees.filter((employee) => (employee.roles || []).some((role) => roleTheme(role).key === 'subcontrata'));
  const employees = allEmployees.filter((employee) => !subcontractors.some((subcontractor) => subcontractor.id === employee.id));
  const tabs = [
    { id: 'employees', label: 'Empleados', items: employees },
    { id: 'subcontractors', label: 'Subcontratas', items: subcontractors },
    { id: 'clients', label: 'Clientes', items: directory?.clients || [] },
    { id: 'projects', label: 'Proyectos', items: directory?.projects || [] },
  ];
  const active = tabs.find((tab) => tab.id === activeTab) || tabs[0];
  const filtered = useMemo(() => { const normalized = query.trim().toLocaleLowerCase('es'); return normalized ? active.items.filter((item) => JSON.stringify(item).toLocaleLowerCase('es').includes(normalized)) : active.items; }, [active.items, query]);
  const selected = filtered.find((item) => item.id === selectedId) || filtered[0] || null;
  const selectTab = (tabId) => { setActiveTab(tabId); setQuery(''); setSelectedId(''); };
  return <section className={panelClass}><div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#F2B66D]">Datos operativos</p><h3 className="mt-1 text-base font-medium text-[#F2F2F2]">Empleados, subcontratas, clientes y proyectos</h3><p className="mt-1 text-xs text-[#737373]">Selecciona un registro para consultar toda la información sincronizada.</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, correo, rol, proyecto..." className="h-9 w-full rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373] lg:w-80" /></div><div className="mt-5 flex flex-wrap gap-2">{tabs.map((tab) => <button key={tab.id} type="button" onClick={() => selectTab(tab.id)} className={`${tabClass} ${activeTab === tab.id ? 'border-[#8FC7E8] bg-[#17303D] text-[#DDF3FF]' : 'border-[#2E2E2E] bg-[#0D0D0D] text-[#A6A6A6] hover:border-[#4B6575] hover:text-[#E8E8E8]'}`}>{tab.label} <span className="ml-1 text-[#8FC7E8]">{tab.items.length}</span></button>)}</div><div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.6fr)]"><div className="max-h-[560px] overflow-y-auto rounded-md border border-[#2E2E2E] bg-[#0D0D0D] p-2">{filtered.map((item) => { const title = activeTab === 'projects' ? item.nombre : fullName(item); const role = activeTab === 'employees' ? primaryRole(item.roles) : null; const theme = roleTheme(role); const subtitle = activeTab === 'employees' ? item.email || item.numero || 'Sin contacto' : activeTab === 'clients' ? item.email || item.telefono || 'Sin contacto' : `${item.cliente_nombre || 'Sin cliente'} · ${item.estado || 'Sin estado'}`; return <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} className={`mb-1 w-full rounded-md border px-3 py-3 text-left transition-colors ${selected?.id === item.id ? 'bg-[#17303D]' : 'border-transparent hover:bg-[#151515]'}`} style={{ borderColor: selected?.id === item.id && role ? theme.border : undefined }}><p className="truncate text-xs font-medium text-[#F2F2F2]">{title}</p>{role && <div className="mt-1"><RoleBadge role={role} compact /></div>}<p className="mt-1 truncate text-[11px] text-[#737373]">{subtitle}</p></button>; })}{!filtered.length && <p className="p-4 text-xs text-[#737373]">No hay resultados para esta búsqueda.</p>}</div><div className="min-h-[340px] rounded-md border border-[#2E2E2E] bg-[#101010] p-4">{selected ? <><div className="mb-4 border-b border-[#2E2E2E] pb-3"><p className="text-[10px] uppercase tracking-[0.18em] text-[#737373]">{active.label.slice(0, -1)}</p><h4 className="mt-1 text-lg font-medium text-[#F2F2F2]">{activeTab === 'projects' ? selected.nombre : fullName(selected)}</h4><p className="mt-1 break-all text-[10px] text-[#737373]">ID: {selected.id}</p></div>{activeTab === 'employees' && <EmployeeDetail employee={selected} />}{activeTab === 'clients' && <ClientDetail client={selected} />}{activeTab === 'projects' && <ProjectDetail project={selected} onCreateAlias={onCreateAlias} onDeleteAlias={onDeleteAlias} />}</> : <p className="text-xs text-[#737373]">Selecciona un registro para ver su ficha.</p>}</div></div></section>;
}

export default function BackofficeView() {
  const [directory, setDirectory] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const refreshDirectory = async () => { const data = await api.directory.overview(); setDirectory(data || null); };
  useEffect(() => { refreshDirectory().catch((error) => setDirectoryError(String(error?.message || 'No se pudo cargar el directorio empresarial.'))); }, []);
  const syncDirectory = async () => { setDirectoryError(''); setSyncing(true); try { await api.directory.sync(); await refreshDirectory(); } catch (error) { setDirectoryError(String(error?.message || 'No se pudo sincronizar el directorio empresarial.')); } finally { setSyncing(false); } };
  const createProjectAlias = async (projectId, alias) => { await api.directory.addProjectAlias(projectId, alias); await refreshDirectory(); };
  const deleteProjectAlias = async (projectId, aliasId) => { await api.directory.removeProjectAlias(projectId, aliasId); await refreshDirectory(); };
  return <div className="ceo-page p-4 sm:p-6 xl:p-8"><h2 className="font-display text-2xl font-medium tracking-wide text-[#F2F2F2]">Backoffice</h2><p className="mt-2 text-xs text-[#737373]">Directorio operativo centralizado para la asignación inteligente de reuniones.</p><div className="mt-8 space-y-6"><DirectoryPanel directory={directory} syncing={syncing} error={directoryError} onSync={syncDirectory} /><DirectoryViews directory={directory} onCreateAlias={createProjectAlias} onDeleteAlias={deleteProjectAlias} /></div></div>;
}