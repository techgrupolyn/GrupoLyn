import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { roleTheme } from '../roleTheme';

const field = 'rounded border border-[#444] bg-[#101010] px-3 py-2 text-sm text-[#eee]';
const button = 'rounded border border-amber-200/40 px-3 py-2 text-xs text-amber-100 hover:bg-amber-200/10 disabled:opacity-40';
const panel = 'rounded border border-[#333] bg-[#141414] p-4';
const names = { organigrama: 'Organigrama y escalado', leads: 'Leads / Prospectos', clients: 'Clientes', identities: 'Identidades sin resolver', incidents: 'Control de obra / Incidencias' };
const stages = { delineante: 'Delineante', pmc: 'PMC / Jefe de proyectos', operations: 'Dirección de operaciones', director: 'Director General', agent: 'Agente IA' };
const leadStates = { new: 'Nuevo', contacted: 'Contactado', qualified: 'Cualificado', won: 'Ganado', lost: 'Descartado' };
const fullName = (person) => [person.nombre, person.apellido].filter(Boolean).join(' ');

export default function OperationsView({ mode = 'organigrama', onOpenMeeting = () => {} }) {
  const [data, setData] = useState([]);
  const [organization, setOrganization] = useState({ positions: [], assignments: [] });
  const [directory, setDirectory] = useState({ employees: [], clients: [], projects: [] });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [lead, setLead] = useState(null);
  const [reason, setReason] = useState('');
  const [person, setPerson] = useState('');
  const [assignment, setAssignment] = useState({ cargo_id: '', empleado_id: '', proyecto_id: '' });
  const [history, setHistory] = useState(null);
  const fetchData = async () => {
    const directoryData = await api.directory.overview();
    const payload = mode === 'organigrama' ? await Promise.all([api.operations.organization(), api.operations.escalations()])
      : mode === 'clients' ? directoryData.clients : await api.operations[mode]();
    return { directoryData, payload };
  };
  const applyData = ({ directoryData, payload }) => {
    setDirectory(directoryData);
    if (mode === 'organigrama') { setOrganization(payload[0]); setData(payload[1]); }
    else setData(payload);
  };
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setSelected(null); setLead(null); setHistory(null); setNotice(''); setPage(1);
    fetchData().then((result) => { if (active) applyData(result); }).catch((failure) => { if (active) setError(failure.body || failure.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode]);
  const refresh = async () => { setLoading(true); try { applyData(await fetchData()); } finally { setLoading(false); } };
  const mutate = async (operation) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); await refresh(); setSelected(null); setLead(null); setReason(''); setPerson(''); setNotice('Cambios guardados en el dashboard. Supabase no se ha modificado.'); }
    catch (failure) { setError(failure.body || failure.message); }
    finally { setBusy(false); }
  };
  const showHistory = async (entity, id) => {
    try { setHistory(await api.operations.history(entity, id)); }
    catch (failure) { setError(failure.body || failure.message); }
  };
  const filtered = useMemo(() => data.filter((row) => JSON.stringify(row).toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))), [data, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const people = [...directory.employees.filter((employee) => employee.activo !== false).map((employee) => ({ key: `employee:${employee.id}`, name: fullName(employee), role: (employee.roles || []).join(', ') || 'Empleado / Subcontrata' })), ...directory.clients.filter((client) => client.activo !== false).map((client) => ({ key: `client:${client.id}`, name: fullName(client), role: 'Cliente' }))];
  return <div className="ceo-page space-y-5 p-4 sm:p-6 xl:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#333] pb-4"><div><h2 className="text-xl font-semibold text-[#eee]">{names[mode]}</h2><p className="mt-2 text-xs text-[#aaa]">Directorio empresarial sincronizado de solo lectura. Las gestiones de este panel se guardan localmente en el dashboard.</p></div><button className={button} disabled={loading || busy} onClick={() => refresh().catch((failure) => setError(failure.body || failure.message))}>Actualizar</button></header>
    {error && <p role="alert" className="rounded border border-red-300/40 p-3 text-sm text-red-200">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-200">{notice}</p>}
    {loading ? <p role="status">Cargando datos…</p> : <>
      {mode === 'organigrama' && <>
        <div className={panel}><h3 className="font-semibold">Jerarquía global y por proyecto</h3><label className="mt-3 block text-xs">Ámbito <select aria-label="Ámbito del organigrama" className={`${field} ml-2`} value={project} onChange={(event) => setProject(event.target.value)}><option value="all">Todos</option><option value="global">Global</option>{directory.projects.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label><p className="mt-3 text-xs text-[#aaa]">Delineante → PMC → Dirección de operaciones → Director General. La cadena omite cargos vacíos; el escalado no aprueba el documento.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">{organization.positions.filter((position) => position.activo).map((position) => {
            const members = organization.assignments.filter((item) => item.cargo_id === position.id && item.activo && item.employee_active && (project === 'all' || (project === 'global' ? !item.proyecto_id : item.proyecto_id === project || !item.proyecto_id)));
            const parent = organization.positions.find((item) => item.id === position.cargo_padre_id);
            return <article className="rounded border border-[#333] p-3" key={position.id}><h4 style={{ color: roleTheme(position.nombre).text }}>{position.nombre}</h4><p className="text-xs text-[#999]">{position.departamento || 'Sin departamento'} · {parent ? `Depende de ${parent.nombre}` : 'Nivel raíz'}</p>{members.map((item) => <div key={item.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#292929] pt-2 text-xs"><span>{item.employee_name} · {item.project_name || 'Global'} · {item.editable ? 'Local' : 'Supabase'}</span>{item.editable && <button disabled={busy} className={button} onClick={() => { if (window.confirm('¿Retirar esta asignación local? Puede cambiar quién revisa las reuniones.')) mutate(() => api.operations.removeAssignment(item.id)); }}>Retirar</button>}</div>)}{!members.length && <p className="mt-2 text-xs text-amber-100">Sin persona activa en este ámbito.</p>}</article>;
          })}</div>
          <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); mutate(() => api.operations.assign(assignment)); }}>
            <select aria-label="Cargo" required className={field} value={assignment.cargo_id} onChange={(event) => setAssignment({ ...assignment, cargo_id: event.target.value })}><option value="">Seleccionar cargo</option>{organization.positions.filter((item) => item.activo).map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select>
            <select aria-label="Empleado" required className={field} value={assignment.empleado_id} onChange={(event) => setAssignment({ ...assignment, empleado_id: event.target.value })}><option value="">Seleccionar empleado</option>{directory.employees.filter((item) => item.activo !== false).map((item) => <option key={item.id} value={item.id}>{fullName(item)}</option>)}</select>
            <select aria-label="Proyecto de asignación" className={field} value={assignment.proyecto_id} onChange={(event) => setAssignment({ ...assignment, proyecto_id: event.target.value })}><option value="">Global</option>{directory.projects.filter((item) => item.activo !== false).map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select><button disabled={busy} className={button}>Añadir asignación local</button>
          </form>
        </div><h3 className="font-semibold">Reuniones pendientes de revisión / Escalado</h3>
      </>}
      <div className="flex flex-wrap gap-3"><input aria-label="Buscar en el panel" placeholder="Buscar nombre, proyecto, estado…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} className={`${field} min-w-64`} />{mode === 'leads' && <button className={button} onClick={() => { setLead({ id: crypto.randomUUID(), name: '', email: '', phone: '', status: 'new', client_id: '', notes: '' }); setSelected(null); }}>Nuevo prospecto</button>}</div>
      {mode === 'identities' && <p className="text-xs text-[#aaa]">Menciones sin persona vinculada en las acciones de reuniones. Resolverlas asigna a la persona seleccionada y registra quién realizó el cambio; no crea ni modifica usuarios de Supabase.</p>}
      {lead && <form className={`${panel} grid gap-3 sm:grid-cols-2`} onSubmit={(event) => { event.preventDefault(); mutate(() => api.operations.saveLead(lead.id, lead)); }}>
        {['name', 'email', 'phone'].map((key) => <label key={key} className="grid gap-1 text-xs">{{ name: 'Nombre', email: 'Correo', phone: 'Teléfono' }[key]}<input required={key === 'name'} type={key === 'email' ? 'email' : 'text'} className={field} value={lead[key] || ''} onChange={(event) => setLead({ ...lead, [key]: event.target.value })} /></label>)}
        <label className="grid gap-1 text-xs">Estado<select className={field} value={lead.status} onChange={(event) => setLead({ ...lead, status: event.target.value })}>{Object.entries(leadStates).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Cliente vinculado<select className={field} value={lead.client_id || ''} onChange={(event) => setLead({ ...lead, client_id: event.target.value })}><option value="">Sin vincular</option>{directory.clients.filter((item) => item.activo !== false).map((item) => <option key={item.id} value={item.id}>{fullName(item)}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Notas<textarea className={field} value={lead.notes} onChange={(event) => setLead({ ...lead, notes: event.target.value })} /></label><div className="flex gap-2"><button disabled={busy} className={button}>Guardar prospecto</button><button type="button" className={button} onClick={() => setLead(null)}>Cancelar</button></div>
      </form>}
      <div className="space-y-3">{visible.map((row) => <article className={panel} key={row.id}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{row.title || row.name || fullName(row)}</h3><p className="mt-1 text-xs text-[#aaa]">{row.meeting_name || row.project_name || row.email || 'Sin referencia adicional'}</p>
          {mode === 'organigrama' && <p className="mt-2 text-xs text-amber-100">{stages[row.workflow_stage]} · {row.waiting_hours} h en espera</p>}
          {mode === 'incidents' && <p className="mt-2 text-xs">{row.resolved ? 'Resuelta' : 'Abierta'} · {row.severity} · {row.detail}<br/>{row.note && `${row.note} · ${row.actor_name}`}</p>}
          {mode === 'leads' && <p className="mt-2 text-xs text-amber-100">{leadStates[row.status]} · {row.client_name || 'Sin cliente vinculado'}</p>}
          {mode === 'identities' && <p className="mt-2 text-xs text-amber-100">Mención: {row.mentioned_name || 'Sin responsable explícito'} · {row.project_name || 'Sin obra'}</p>}
        </div><div className="flex flex-wrap gap-2">
          {['organigrama', 'identities', 'incidents'].includes(mode) && <button className={button} onClick={() => onOpenMeeting(row.artifact_id || row.id)}>Abrir reunión</button>}
          <button className={button} onClick={() => { if (mode === 'leads') setLead({ ...row }); else setSelected(row); setReason(''); setPerson(''); }}>{mode === 'organigrama' ? 'Escalar' : mode === 'incidents' ? row.resolved ? 'Reabrir' : 'Resolver' : mode === 'identities' ? 'Vincular persona' : mode === 'leads' ? 'Editar' : 'Ver ficha'}</button>
          {['leads', 'incidents'].includes(mode) && <button className={button} onClick={() => showHistory(mode === 'leads' ? 'lead' : 'incident', row.id)}>Historial</button>}
        </div></div>
        {selected?.id === row.id && <div className="mt-4 border-t border-[#333] pt-3">
          {mode === 'clients' ? <><p className="text-sm">{row.email || 'Sin correo'} · {row.telefono || 'Sin teléfono'} · {row.activo ? 'Activo' : 'Inactivo'}</p><h4 className="mt-3 text-xs font-semibold">Proyectos y equipo asignado</h4>{directory.projects.filter((item) => item.cliente_id === row.id).map((item) => <p key={item.id} className="mt-2 text-xs">{item.nombre} · {item.estado || 'Sin estado'}<br/>{(item.asignaciones || []).map((member) => `${member.nombre} (${member.rol || 'Sin rol'})`).join(' · ') || 'Sin equipo vinculado'}</p>)}</>
            : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); mutate(() => {
              if (mode === 'organigrama') return api.operations.escalate(row.id, reason);
              if (mode === 'incidents') return api.operations.resolveIncident(row.id, !row.resolved, reason);
              const divider = person.indexOf(':'); return api.meetings.assignResponsible(row.artifact_id, row.id, { kind: person.slice(0, divider), id: person.slice(divider + 1) });
            }); }}>
              {mode === 'identities' ? <label className="grid gap-2 text-xs">Persona del directorio<select required aria-label="Persona del directorio" className={field} value={person} onChange={(event) => setPerson(event.target.value)}><option value="">Seleccionar persona</option>{people.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.role}</option>)}</select></label> : <label className="grid gap-2 text-xs">Motivo<textarea required minLength={5} className={field} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
              {mode === 'organigrama' && <p className="text-xs text-amber-100">Pasa al siguiente cargo disponible sin aprobar ni publicar acciones. Quedará registrado en la cadena de cambios.</p>}
              <button disabled={busy} className={button}>Confirmar cambio</button>
            </form>}
          <button className={`${button} mt-3`} onClick={() => setSelected(null)}>Cerrar</button>
        </div>}
      </article>)}{!visible.length && <p className={panel}>No hay registros que coincidan con los filtros.</p>}</div>
      <div className="flex items-center justify-between text-xs"><button className={button} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Anterior</button><span>{filtered.length} registros · Página {currentPage} de {pages}</span><button className={button} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Siguiente</button></div>
    </>}
    {history && <section className={panel} aria-label="Historial de cambios"><div className="flex justify-between"><h3 className="font-semibold">Historial de cambios</h3><button className={button} onClick={() => setHistory(null)}>Cerrar historial</button></div>{history.map((event, index) => <details key={`${event.created_at}-${index}`} className="mt-3"><summary className="text-xs">{event.actor_name} · {new Date(event.created_at).toLocaleString('es-ES')}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ antes: event.before_data, despues: event.after_data }, null, 2)}</pre></details>)}{!history.length && <p className="mt-3 text-xs">Sin cambios locales registrados.</p>}</section>}
  </div>;
}
