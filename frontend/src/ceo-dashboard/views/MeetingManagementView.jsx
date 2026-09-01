import { useEffect, useMemo, useState } from 'react';
import api from '../api';
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
  return ({ agent: 'Agente', delineante: 'Delineante', pmc: 'PMC', operations: 'Dirección Operaciones' })[stage] || 'Agente';
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
  const stages = ['agent', 'delineante', 'pmc', 'operations'];
  const current = Math.max(stages.indexOf(stage), 0);
  return <div className="flex items-center gap-1">{stages.map((item, index) => <span key={item} title={workflowLabel(item)} className={`size-2 rounded-full ${index <= current ? index === current ? 'bg-amber-300' : 'bg-emerald-300' : 'bg-[#2E2E2E]'}`} />)}</div>;
}

function formatActionDueDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'Sin fecha' : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

function ActionEditor({ action, onSave, onDelete, busy }) {
  const [editing, setEditing] = useState(false);
  const [showAdditionalResponsibles, setShowAdditionalResponsibles] = useState(false);
  const [form, setForm] = useState(() => ({ ...emptyAction, ...action, due_date: action.due_date ? String(action.due_date).slice(0, 10) : '', estimated_minutes: action.estimated_minutes ?? '' }));
  const additionalResponsibles = (action.responsibles || []).filter((person) => person.employee_id !== action.responsible_id);
  const hasLinkedResponsibles = Array.isArray(action.responsibles) && action.responsibles.length > 0;
  const missingResponsible = action.status === 'pending' && !String(action.responsible || '').trim() && !hasLinkedResponsibles;
  const missingDueDate = action.status === 'pending' && !action.due_date;
  const primaryRoleTone = roleTheme(action.responsible_role);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  if (editing) return <form onSubmit={(event) => { event.preventDefault(); onSave(form).then((saved) => { if (saved) setEditing(false); }); }} className="rounded border border-sky-300/30 bg-[#141414] p-3"><input required value={form.title} onChange={(event) => set('title', event.target.value)} placeholder="Acción" className="h-9 w-full ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /><div className="mt-2 grid gap-2 sm:grid-cols-2"><input value={form.project_name} onChange={(event) => set('project_name', event.target.value)} placeholder="Obra" className="h-8 ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-[11px] text-[#F2F2F2] outline-none" /><input value={form.responsible} onChange={(event) => set('responsible', event.target.value)} placeholder="Responsable" className="h-8 ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-[11px] text-[#F2F2F2] outline-none" /><input type="date" value={form.due_date} onChange={(event) => set('due_date', event.target.value)} className="h-8 ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-[11px] text-[#F2F2F2] outline-none" /><input type="number" min="0" value={form.estimated_minutes} onChange={(event) => set('estimated_minutes', event.target.value)} placeholder="Minutos estimados" className="h-8 ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-[11px] text-[#F2F2F2] outline-none" /></div><input value={form.source_ref} onChange={(event) => set('source_ref', event.target.value)} placeholder="Minuto y evidencia (ej. min 14:20 — cita)" className="mt-2 h-8 w-full ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-[11px] text-[#F2F2F2] outline-none" /><div className="mt-3 flex gap-2"><button disabled={busy} className="ceo-button-primary rounded px-3 py-1.5 text-[11px] font-semibold">Guardar</button><button type="button" onClick={() => setEditing(false)} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[11px] text-[#BFBFBF]">Cancelar</button></div></form>;

  return <article className={`rounded border p-3 ${missingResponsible ? 'border-amber-300/55 bg-amber-300/[0.03]' : 'border-[#2E2E2E] bg-[#141414]'}`}><div className="flex gap-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium leading-5 text-[#F2F2F2]">{action.title}{action.origin === 'ai' && <span className="ml-2 rounded border border-sky-300/30 bg-sky-300/10 px-1.5 py-0.5 text-[9px] font-normal uppercase tracking-wide text-sky-200">IA</span>}</p><div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[#BFBFBF]">{action.project_id && <span className="rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-1.5 py-1 text-emerald-100">✓ Proyecto vinculado</span>}{action.responsible_role && <span className="rounded border px-1.5 py-1" style={{ color: primaryRoleTone.text, borderColor: primaryRoleTone.border, backgroundColor: primaryRoleTone.background }}>{roleLabel(action.responsible_role)}</span>}<span className="rounded border border-[#2E2E2E] bg-[#0D0D0D] px-1.5 py-1">{action.project_name || 'Sin obra'}</span><span className={`rounded border px-1.5 py-1 ${action.responsible ? 'border-[#2E2E2E] bg-[#0D0D0D]' : 'border-amber-300/30 bg-amber-300/10 text-amber-200'}`}>{action.responsible || 'Pendiente de asignar'}</span><span className={`rounded border px-1.5 py-1 ${action.due_date ? 'border-[#2E2E2E] bg-[#0D0D0D]' : 'border-amber-300/30 bg-amber-300/10 text-amber-200'}`}>{formatActionDueDate(action.due_date)}</span>{action.estimated_minutes && <span className="rounded border border-[#2E2E2E] bg-[#0D0D0D] px-1.5 py-1">min {action.estimated_minutes}</span>}</div>{additionalResponsibles.length > 0 && <div className="mt-2"><button type="button" onClick={() => setShowAdditionalResponsibles((current) => !current)} className="text-[10px] text-sky-200 hover:text-sky-100">{showAdditionalResponsibles ? 'Ocultar responsables adicionales' : `Ver ${additionalResponsibles.length} responsable${additionalResponsibles.length === 1 ? '' : 's'} adicional${additionalResponsibles.length === 1 ? '' : 'es'}`}</button>{showAdditionalResponsibles && <div className="mt-2 flex flex-wrap gap-1.5">{additionalResponsibles.map((person) => <span key={person.employee_id} className="rounded border px-1.5 py-1 text-[10px]" style={{ color: roleTheme(person.role).text, borderColor: roleTheme(person.role).border, backgroundColor: roleTheme(person.role).background }}>✓ {person.name}{person.role ? ` · ${roleLabel(person.role)}` : ''}</span>)}</div>}</div>}{action.source_ref && <p className="mt-2 font-mono text-[10px] text-[#737373]">{action.source_ref}</p>}{missingResponsible && <p className="mt-2 text-[11px] text-amber-200">⚠ Falta responsable para aprobar.</p>}{missingDueDate && <p className="mt-1 text-[11px] text-amber-200">⚠ Fecha sin asignar (opcional).</p>}</div><div className="flex shrink-0 gap-2 text-[10px]"><button type="button" onClick={() => setEditing(true)} className="text-[#BFBFBF] hover:text-[#F2F2F2]">Editar</button><button type="button" onClick={onDelete} disabled={busy} className="text-[#737373] hover:text-red-300">×</button></div></div></article>;
}

function MeetingDrawer({ meeting, onClose, onChanged }) {
  const [draft, setDraft] = useState(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [addingAction, setAddingAction] = useState(false);
  const [newAction, setNewAction] = useState(emptyAction);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const isNewMeeting = draft?.id !== meeting?.id;
    if (isNewMeeting || !dirty) setDraft(meeting ? { ...meeting } : null);
    if (isNewMeeting) {
      setShowTranscript(false);
      setAddingAction(false);
      setError('');
      setDirty(false);
    }
  }, [meeting, dirty]);
  if (!meeting || !draft) return null;
  const blockers = meeting.blockers || { missingResponsible: 0, missingDueDate: 0 };
  const blocked = Boolean(blockers.missingResponsible);
  const detectedBlockers = meeting.detected_blockers || [];
  const save = async () => { setBusy('meeting'); setError(''); try { await api.meetings.update(meeting.id, draft); setDirty(false); await onChanged(meeting.id); } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo guardar la reunión.'); } finally { setBusy(''); } };
  const updateAction = async (actionId, form) => { setBusy(actionId); setError(''); try { await api.meetings.updateAction(meeting.id, actionId, form); await onChanged(meeting.id); return true; } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo actualizar la acción.'); return false; } finally { setBusy(''); } };
  const removeAction = async (actionId) => { if (!window.confirm('¿Eliminar esta acción?')) return; setBusy(actionId); setError(''); try { await api.meetings.deleteAction(meeting.id, actionId); await onChanged(meeting.id); } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo eliminar la acción.'); } finally { setBusy(''); } };
  const addAction = async (event) => { event.preventDefault(); setBusy('new'); try { await api.meetings.addAction(meeting.id, newAction); setNewAction(emptyAction); setAddingAction(false); await onChanged(meeting.id); } catch (requestError) { setError(requestError.message); } finally { setBusy(''); } };
  const workflow = async (command) => { if (dirty) { setError('Guardá los cambios de la reunión antes de actualizar la cadena de revisión.'); return; } const reason = command === 'return' ? (window.prompt('Motivo de devolución:') || '') : ''; setBusy(command); setError(''); try { await api.meetings.workflow(meeting.id, command, reason); await onChanged(meeting.id); } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo actualizar la cadena de revisión.'); } finally { setBusy(''); } };
  const analyze = async () => { if (dirty) { setError('Guardá los cambios de la reunión antes de regenerar el análisis.'); return; } setBusy('analyze'); setError(''); try { await api.meetings.analyze(meeting.id); await onChanged(meeting.id); } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo analizar la reunión.'); } finally { setBusy(''); } };
  const setDraftValue = (key, value) => { setDirty(true); setDraft((current) => ({ ...current, [key]: value })); };

  return <aside role="dialog" aria-modal="true" aria-label="Detalle de reunión" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[680px] flex-col border-l border-[#2E2E2E] bg-[#0D0D0D] shadow-2xl">
    <div className="flex items-start justify-between gap-4 border-b border-[#2E2E2E] bg-[#141414] px-4 py-4"><div className="min-w-0"><h2 className="truncate text-sm font-semibold text-[#F2F2F2]">{meeting.name}</h2><div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[#737373]"><span>Reunión: {formatMeetingDate(draft.meeting_date)}</span><span className={`rounded border px-1.5 py-0.5 ${draft.analysis_status === 'completed' ? 'border-emerald-300/30 text-emerald-200' : draft.analysis_status === 'failed' ? 'border-red-300/30 text-red-200' : 'border-amber-300/30 text-amber-200'}`}>{analysisStatusLabel(draft.analysis_status)}</span><span className="rounded border border-[#2E2E2E] px-1.5 py-0.5">{meetingKindLabel(draft.meeting_kind)}</span><span className="rounded border border-[#2E2E2E] px-1.5 py-0.5">PMC a cargo: {draft.pmc || 'Pendiente'}</span></div></div><button type="button" onClick={onClose} className="rounded p-1 text-[#737373] hover:text-[#F2F2F2]" aria-label="Cerrar">✕</button></div>
    <div className="flex-1 overflow-y-auto p-4"><div className="mb-5 flex items-center justify-between gap-3"><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Cadena de revisión</p><div className="flex items-center gap-3"><button type="button" onClick={analyze} disabled={busy === 'analyze' || draft.analysis_status === 'processing' || dirty} className="rounded border border-sky-300/40 bg-sky-300/10 px-2.5 py-1.5 text-[10px] font-medium text-sky-100 hover:border-sky-300 disabled:opacity-40">{busy === 'analyze' ? 'Analizando documento…' : draft.analysis_status === 'completed' ? 'Regenerar análisis' : draft.analysis_status === 'processing' ? 'Análisis en curso' : 'Analizar ahora'}</button><WorkflowDots stage={draft.workflow_stage} /></div></div>
      {error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
      {draft.analysis_status === 'failed' && <p className="mb-4 rounded border border-amber-300/40 bg-amber-300/[0.08] p-3 text-xs text-amber-100">{draft.analysis_error || 'El análisis automático no pudo completarse. Puedes reintentarlo.'}</p>}
      <section className="mb-5 rounded border border-[#2E2E2E] bg-[#141414] p-3"><div className="mb-3 flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Identificación de reunión</p><button type="button" onClick={save} disabled={busy === 'meeting'} className="text-[11px] text-sky-300 hover:text-sky-200">{busy === 'meeting' ? 'Guardando…' : 'Guardar datos'}</button></div><div className="grid gap-2 sm:grid-cols-2"><label className="text-[10px] text-[#737373]">Tipo<select value={draft.meeting_kind || 'MEET'} onChange={(event) => setDraftValue('meeting_kind', event.target.value)} className="mt-1 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none"><option value="COMITE_OBRA">Comité de obra</option><option value="REUNION_CLIENTE">Reunión cliente</option><option value="MEET">Reunión</option></select></label><label className="text-[10px] text-[#737373]">PMC a cargo<input value={draft.pmc || ''} onChange={(event) => setDraftValue('pmc', event.target.value)} placeholder="Nombre del PMC a cargo" className="mt-1 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /></label><label className="text-[10px] text-[#737373]">Obra<input value={draft.project_name || ''} onChange={(event) => setDraftValue('project_name', event.target.value)} placeholder="Obra o proyecto" className="mt-1 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /></label><label className="text-[10px] text-[#737373]">Contacto<input value={draft.contact_name || ''} onChange={(event) => setDraftValue('contact_name', event.target.value)} placeholder="Cliente o contacto" className="mt-1 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /></label><label className="text-[10px] text-[#737373]">Fecha de reunión<input type="date" value={draft.meeting_date || ''} onChange={(event) => setDraftValue('meeting_date', event.target.value)} className="mt-1 h-8 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /></label></div>{(draft.project_id || draft.contact_id || draft.pmc_employee_id) && <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">{draft.project_id && <span className="rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-1.5 py-1 text-emerald-100">✓ Proyecto vinculado</span>}{draft.contact_id && <span className="rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-1.5 py-1 text-emerald-100">✓ Cliente vinculado</span>}{draft.pmc_employee_id && <span className="rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-1.5 py-1 text-emerald-100">✓ PMC vinculado</span>}</div>}{meeting.source_name && <p className="mt-3 truncate font-mono text-[10px] text-[#737373]">Archivo fuente: {meeting.source_name}</p>}</section>
      <section><div className="mb-2 flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Resumen <span className="normal-case tracking-normal">con referencias de minuto cuando existan</span></p><button type="button" onClick={save} disabled={busy === 'meeting'} className="text-[11px] text-sky-300 hover:text-sky-200">{busy === 'meeting' ? 'Guardando…' : 'Guardar'}</button></div><textarea value={draft.summary || ''} onChange={(event) => setDraftValue('summary', event.target.value)} rows="6" className="w-full ceo-surface rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs leading-5 text-[#D4D4D4] outline-none" /></section>
      <section className="mt-5"><p className="mb-2 font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Decisiones <span className="normal-case tracking-normal">con referencias de minuto cuando existan</span></p><textarea value={draft.decisions || ''} onChange={(event) => setDraftValue('decisions', event.target.value)} rows="4" placeholder="Añadí las decisiones confirmadas de la reunión." className="w-full ceo-surface rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs leading-5 text-[#D4D4D4] outline-none" /></section>
      <section className="mt-5"><div className="mb-2 flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Acciones detectadas <span className="normal-case tracking-normal">{meeting.actions?.length || 0} acciones</span></p><button type="button" onClick={() => setAddingAction(true)} className="rounded border border-[#2E2E2E] px-2 py-1 text-[10px] text-[#BFBFBF] hover:border-sky-300/50">+ Añadir</button></div><div className="space-y-2">{(meeting.actions || []).map((action) => <ActionEditor key={action.id} action={action} busy={busy === action.id} onSave={(form) => updateAction(action.id, form)} onDelete={() => removeAction(action.id)} />)}{!meeting.actions?.length && <p className="rounded border border-dashed border-[#2E2E2E] p-4 text-xs text-[#737373]">No hay acciones todavía. Añadí las que el agente no detectó.</p>}</div>{addingAction && <form onSubmit={addAction} className="mt-2 rounded border border-sky-300/30 bg-[#141414] p-3"><input required value={newAction.title} onChange={(event) => setNewAction((current) => ({ ...current, title: event.target.value }))} placeholder="Nueva acción" className="h-9 w-full ceo-surface rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" /><div className="mt-2 flex gap-2"><button disabled={busy === 'new'} className="ceo-button-primary rounded px-3 py-1.5 text-[11px] font-semibold">Añadir acción</button><button type="button" onClick={() => setAddingAction(false)} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[11px] text-[#BFBFBF]">Cancelar</button></div></form>}</section>
      <section className="mt-5"><p className="mb-2 font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Bloqueos detectados</p><div className="space-y-2">{detectedBlockers.map((blocker) => <article key={blocker.id} className={"rounded border p-3 text-xs leading-5 " + blockerTone(blocker.severity)}><div className="flex items-start justify-between gap-3"><p className="font-medium">{blocker.title}</p><span className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] uppercase">{blocker.severity}</span></div>{blocker.detail && <p className="mt-1 text-[#BFBFBF]">{blocker.detail}</p>}{blocker.source_ref && <p className="mt-2 font-mono text-[10px] text-[#737373]">{blocker.source_ref}</p>}</article>)}{!detectedBlockers.length && <p className="rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs leading-5 text-[#737373]">Generá el análisis con IA para detectar riesgos, dependencias y bloqueos presentes en la transcripción.</p>}</div>{blocked && <p className="mt-2 rounded border border-amber-300/40 bg-amber-300/[0.08] p-3 text-xs leading-5 text-[#D4D4D4]">Aprobación bloqueada: {blockers.missingResponsible} acciones sin responsable. La fecha sigue siendo opcional.</p>}</section>
      <section className="mt-5"><p className="mb-3 font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Cadena y versiones</p><div className="space-y-3 border-l border-[#2E2E2E] pl-3">{(meeting.versions || []).map((version) => <div key={version.id} className="relative"><span className="absolute -left-[17px] top-1 size-2 rounded-full bg-emerald-300" /><p className="text-xs font-medium text-[#F2F2F2]">{workflowLabel(version.stage)} · {version.actor}</p><p className="mt-0.5 text-[11px] text-[#737373]">{version.detail || 'Actualización'} · {formatDate(version.created_at)}</p></div>)}</div></section>
      <section className="mt-5"><button type="button" onClick={() => setShowTranscript((current) => !current)} className="rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] hover:border-sky-300/50">{showTranscript ? 'Ocultar transcripción' : 'Ver transcripción'}</button>{showTranscript && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs leading-5 text-[#D4D4D4]">{meeting.content_text || 'No hay texto extraído de este archivo.'}</pre>}</section>
    </div>
    <div className="border-t border-[#2E2E2E] bg-[#141414] p-4"><p className={`mb-3 rounded border p-3 text-xs ${blocked ? 'border-amber-300/40 bg-amber-300/[0.08] text-[#F2F2F2]' : 'border-emerald-300/30 bg-emerald-300/[0.06] text-[#F2F2F2]'}`}>{blocked ? 'Aprobación bloqueada. Asigná responsable a las acciones pendientes.' : 'Lista para aprobación. La fecha es opcional.'}</p><div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(blocked) || dirty || busy === 'approve'} onClick={() => workflow('approve')} className="ceo-button-primary rounded px-3 py-2 text-xs font-semibold disabled:opacity-40">Aprobar y pasar a Dir. Operaciones</button><button type="button" disabled={dirty || busy === 'save'} onClick={() => workflow('save')} className="rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#F2F2F2] hover:border-sky-300/50">Guardar sin aprobar</button><button type="button" disabled={dirty || busy === 'return'} onClick={() => workflow('return')} className="rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#F2F2F2] hover:border-amber-300/60">Devolver al Delineante</button></div></div>
  </aside>;
}

export default function MeetingManagementView() {
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
      if (options) setDetectedPmcs(options.pmcs || []);
      setPagination({ page: result.page || targetPage, pageSize: result.pageSize || 25, total: result.total || 0, totalPages: result.totalPages || 0 });
      setMetrics(result.metrics || { pending: 0, awaiting: 0, unassigned: 0, no_project: 0 });
    } catch (requestError) {
      setError(requestError.body || requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void api.directory.overview().then((result) => setDirectory(result || null)).catch(() => setDirectory({ employees: [], clients: [], projects: [] }));
    void api.meetings.filterOptions().then((result) => setDetectedPmcs(result?.pmcs || [])).catch(() => setDetectedPmcs([]));
  }, []);
  useEffect(() => {
    void load(page);
    const timer = window.setInterval(() => { void load(page); }, 15_000);
    return () => window.clearInterval(timer);
  }, [page, query, filter, projectId, pmc, contactId, role, dateFrom, dateTo, recentDays, sort]);
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
      <div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#737373]">Agente de reuniones</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-[#F2F2F2]">Gestión de reuniones</h2><p className="mt-1 text-xs text-[#737373]">Revisá y aprobá los borradores operativos importados desde Google Drive.</p></div>
      <div className="flex flex-wrap gap-2"><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Buscar contacto, teléfono, email u obra…" className="h-9 w-72 max-w-full ceo-surface rounded border border-[#2E2E2E] bg-[#141414] px-3 text-xs text-[#F2F2F2] outline-none" /><button type="button" onClick={reanalyzeMissingPmc} disabled={requeueing} className="h-9 rounded border border-amber-300/35 bg-amber-300/[0.08] px-3 text-xs font-medium text-amber-100 hover:border-amber-300 disabled:opacity-40">{requeueing ? 'Encolando PMC…' : 'Reanalizar PMC pendientes'}</button><button type="button" onClick={retag} disabled={retagging} className="h-9 rounded border border-emerald-300/35 bg-emerald-300/[0.08] px-3 text-xs font-medium text-emerald-100 hover:border-emerald-300 disabled:opacity-40">{retagging ? 'Vinculando…' : 'Vincular directorio'}</button></div>
    </div>
    {error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
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
    {selected && <><button type="button" aria-label="Cerrar detalle" onClick={() => setSelected(null)} className="fixed inset-0 z-40 bg-black/60" /><MeetingDrawer meeting={selected} onClose={() => setSelected(null)} onChanged={refreshSelected} /></>}
  </section>;
}