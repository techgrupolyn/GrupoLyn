import { useEffect, useRef, useState } from 'react';
import api from '../api';

const fieldStyle = 'w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] p-2 text-xs';
const buttonStyle = 'rounded border border-[#2E2E2E] px-2 py-1 text-xs disabled:opacity-40';

function ActionProjectPicker({ action, projects, busy, onSave }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const filtered = projects.filter((project) => normalize(project.name).includes(normalize(query)));
  return <article className="rounded-md border border-amber-300/50 bg-amber-300/[.035] p-3">
    <p className="text-sm font-medium leading-5 text-[#F2F2F2]">{action.title}</p>
    <button type="button" disabled={busy} aria-label={`Asignar obra: ${action.title}`} aria-expanded={open} onClick={() => { setOpen(!open); setQuery(''); setSelected(''); }} className="mt-2 rounded border border-amber-300/35 bg-amber-300/10 px-1.5 py-1 text-[10px] text-amber-200 disabled:opacity-40">Asignar obra</button>
    {open && <div className="mt-3 rounded border border-amber-300/35 bg-[#141414] p-3">
      <div className="flex justify-between gap-2"><p className="text-[11px] font-medium text-amber-100">Obra de la acción</p><button type="button" disabled={busy} onClick={() => { setOpen(false); setSelected(''); }} className="text-[10px] text-[#737373]">Cancelar</button></div>
      <input autoFocus aria-label={`Buscar obra: ${action.title}`} disabled={busy} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(''); }} placeholder="Buscar por nombre de obra…" className="mt-2 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-white outline-none" />
      <div role="listbox" aria-label={`Resultados de obras: ${action.title}`} className="mt-2 max-h-48 space-y-1 overflow-auto">
        {filtered.map((project) => <button key={project.id} type="button" role="option" disabled={busy} aria-selected={selected === project.id} onClick={() => setSelected(project.id)} className={`flex w-full items-center rounded border px-2 py-1.5 text-left text-xs ${selected === project.id ? 'border-amber-300/60 bg-amber-300/10' : 'border-[#2E2E2E] bg-[#0D0D0D]'}`}>{project.name}</button>)}
        {!filtered.length && <p className="text-center text-[11px] text-[#737373]">No hay coincidencias.</p>}
      </div>
      <button type="button" disabled={busy || !selected} onClick={async () => { if (await onSave(selected)) setOpen(false); }} className="ceo-button-primary mt-3 rounded px-3 py-1.5 text-[11px] disabled:opacity-40">{busy ? 'Guardando…' : 'Guardar obra'}</button>
    </div>}
    {action.project_name && <p className="mt-2 text-[11px] text-[#A3A3A3]">Obra mencionada: {action.project_name}</p>}
    {action.source_ref && <p className="mt-2 font-mono text-[10px] text-[#737373]">{action.source_ref}</p>}
  </article>;
}

export default function MeetingResolutionPanel({ meetingId, linkedProjects = [], onSaved }) {
  const [projects, setProjects] = useState([]);
  const [tab, setTab] = useState('actions');
  const [detail, setDetail] = useState(null);
  const [reviewerId, setReviewerId] = useState('');
  const [directory, setDirectory] = useState(null);
  const [selection, setSelection] = useState({ startCargoId: null, reviewers: {} });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    let active = true;
    api.projectMeetings.reviewerProjects().then((items) => {
      if (active) setProjects(items);
    }).catch((failure) => { if (active) setError(failure.body || failure.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => { void load('actions', meetingId); }, [meetingId]);
  useEffect(() => () => { request.current++; }, []);
  async function load(kind, id) {
    const ticket = ++request.current;
    setError(''); setNotice(''); setReason(''); setBusy(true);
    setDetail(null); setDirectory(null);
    try {
      if (!id) return;
      const result = await (kind === 'actions' ? api.projectMeetings.resolutionDetail(id) : api.projectMeetings.reviewers(id));
      if (ticket !== request.current) return;
      if (kind === 'actions') setDetail(result);
      else {
        setDirectory(result);
        const reviewers = Object.fromEntries(Object.entries(result.selection?.reviewers || {}).filter(([cargoId, employeeId]) => result.team.some((person) => person.id === employeeId && person.cargoIds.includes(cargoId))));
        setSelection({ startCargoId: result.team.some((person) => person.cargoIds.includes(result.selection?.startCargoId)) ? result.selection.startCargoId : null, reviewers });
      }
    } catch (failure) { if (ticket === request.current) setError(failure.body || failure.message); }
    finally { if (ticket === request.current) setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      await api.projectMeetings.saveReviewers(reviewerId, { selection, reason });
      setDirectory(await api.projectMeetings.reviewers(reviewerId));
      setReason(''); setNotice('Vinculación guardada. Club LYN no se ha modificado.'); await onSaved?.();
    } catch (failure) { setError(failure.body || failure.message); }
    finally { setBusy(false); }
  }
  async function saveActionProject(actionId, projectId) {
    if (busy || !projects.some((project) => project.id === projectId)) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.projectMeetings.linkProjects(detail.id, {
        actionIds: actionId ? [actionId] : [], projectId,
        reason: actionId ? 'Obra asignada manualmente desde la acción en el panel de reunión.' : 'Obra asignada manualmente desde el panel de reunión sin acciones.',
      });
      setDetail(await api.projectMeetings.resolutionDetail(meetingId));
      setNotice('Vinculación guardada. Club LYN no se ha modificado.');
      await onSaved?.();
      return true;
    } catch (failure) { setError(failure.body || failure.message); return false; }
    finally { setBusy(false); }
  }
  const hasPmc = directory?.team.some((person) => person.cargoIds.some((cargoId) => directory.positions.some((position) => position.id === cargoId && position.final)));
  const occupied = directory?.positions.filter((position) => !position.director && directory.team.some((person) => person.cargoIds.includes(position.id))) || [];
  return <div className="space-y-3 text-xs text-[#BFBFBF]">
    <div className="flex gap-2">{[['actions', 'Acciones sin obra'], ...(linkedProjects.length ? [['reviewers', 'PMC y revisores']] : [])].map(([key, label]) => <button type="button" key={key} className={buttonStyle} disabled={busy} aria-pressed={tab === key} onClick={() => { if (tab === key && (key !== 'actions' || detail)) return; request.current++; setTab(key); setDetail(null); setDirectory(null); setReviewerId(''); setReason(''); setError(''); setNotice(''); if (key === 'actions') void load('actions', meetingId); }}>{label}</button>)}</div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
    {busy && <p role="status">Procesando…</p>}
    {tab === 'actions' ? <>
      {detail && !detail.noActions && !detail.actions.length && <p className="text-sm text-[#A3A3A3]">Todas las acciones de esta reunión tienen obra vinculada.</p>}
      {detail && (detail.noActions || detail.actions.length > 0) && <>
        {detail.noActions ? <><p className="text-sm">Esta reunión no tiene acciones. Se vinculará la reunión a la obra seleccionada.</p><ActionProjectPicker key={detail.id} action={{ title: detail.name }} projects={projects} busy={busy} onSave={(projectId) => saveActionProject(null, projectId)} /></> : <div className="space-y-2">{detail.actions.map((action) => <ActionProjectPicker key={action.id} action={action} projects={projects} busy={busy} onSave={(projectId) => saveActionProject(action.id, projectId)} />)}</div>}
      </>}
    </> : <>
      <label className="block text-sm">Obra a revisar<select className={fieldStyle} disabled={busy} value={reviewerId} onChange={(event) => { setReviewerId(event.target.value); load('reviewers', event.target.value); }}><option value="">Selecciona una obra</option>{linkedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {directory && <>
        <p className="text-sm">{directory.snapshot.issue || `Cadena resuelta: ${directory.snapshot.path.map((step) => step.name).join(' → ')}`}</p>
        {!hasPmc && <p className="text-sm text-amber-300">Esta obra no tiene PMC asignado en Club LYN. El último cargo ocupado cierra la revisión sin cambiar su cargo. Los empates y la ausencia de revisores requieren resolución.</p>}
        {occupied.map((position) => {
          const members = directory.team.filter((person) => person.cargoIds.includes(position.id));
          const automatic = directory.automaticReviewers[position.id];
          if (members.length === 1 || automatic) return <p key={position.id} className="text-sm text-[#A3A3A3]">{position.name}: {members.find((person) => person.id === automatic)?.name || members[0].name} · Automático por asignación</p>;
          return <label key={position.id} className="block text-sm">Revisor de {position.name}<select className={fieldStyle} disabled={busy} value={selection.reviewers[position.id] || ''} onChange={(event) => { const reviewers = { ...selection.reviewers }; if (event.target.value) reviewers[position.id] = event.target.value; else delete reviewers[position.id]; setSelection({ ...selection, reviewers }); }}><option value="">Confirma el revisor (fecha empatada o ausente)</option>{members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>;
        })}
        {occupied.filter((position) => !position.final).length > 1 && <label className="block text-sm">Inicio de la cadena (solo si hay recorridos ambiguos)<select className={fieldStyle} disabled={busy} value={selection.startCargoId || ''} onChange={(event) => setSelection({ ...selection, startCargoId: event.target.value || null })}><option value="">Automático desde el peldaño inferior</option>{occupied.filter((position) => !position.final).map((position) => <option key={position.id} value={position.id}>{position.name}</option>)}</select></label>}
      </>}
    </>}
    {directory && <><label className="block text-sm">Motivo de la vinculación<textarea className={fieldStyle} disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="ceo-button-primary rounded px-3 py-2 text-xs font-semibold disabled:opacity-40" disabled={busy || !occupied.length || !reason.trim()} onClick={save}>Guardar vinculación</button></>}
  </div>;
}
