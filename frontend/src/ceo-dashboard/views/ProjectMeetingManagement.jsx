import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import MeetingReviewDrawer from './MeetingReviewDrawer';
import MeetingResolutionPanel from './MeetingResolutionPanel';

const control = 'rounded border border-[#4A4A4A] bg-[#141414] px-2 py-2 text-xs text-[#BFBFBF] disabled:opacity-40';

function directoryFor(people, branches) {
  return { clients: [], employees: people.map((person) => ({
    id: person.id, nombre: person.name, activo: true,
    roles: [person.is_director ? 'Director' : branches.flatMap((branch) => branch.snapshot.path).find((step) => step.employeeId === person.id)?.cargo || 'Empleado'],
  })) };
}

export default function ProjectMeetingReviewDrawer({ meeting, onClose, onChanged, canResolve = false }) {
  const [selectedBranch, setSelectedBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const container = useRef(null);
  const workflowPending = useRef(false);
  const branch = meeting.branches.find((item) => item.id === selectedBranch) || meeting.branches.find((item) => item.can_review) || meeting.branches[0];
  const readOnly = !meeting.enabled || meeting.status === 'approved';
  const resolution = canResolve && meeting.status !== 'approved' ? <MeetingResolutionPanel meetingId={meeting.id} linkedProjects={meeting.branches.filter((item) => item.project_id).map((item) => ({ id: item.project_id, name: item.project_name }))} onSaved={() => onChanged(meeting.id)} /> : null;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focus = window.requestAnimationFrame(() => container.current?.querySelector('[aria-label="Cerrar"]')?.focus());
    return () => { window.cancelAnimationFrame(focus); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  function keyboard(event) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...container.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')].filter((element) => element.getClientRects().length);
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const adapted = useMemo(() => {
    const projects = (meeting.add_projects || []).filter((project) => !branch || project.id === branch.project_id);
    const scopedActions = meeting.actions.filter((action) => !branch || action.project_id === branch.project_id);
    const pmcs = [...new Map((branch ? [branch] : meeting.branches).flatMap((item) => item.snapshot.path.filter((step) => step.employeeId === item.snapshot.pmcId)).map((step) => [step.employeeId, step])).values()];
    return {
      ...meeting, partial_scope: meeting.partial_scope || Boolean(meeting.resolution_only), project_name: projects.map((project) => project.name).join(' / '), project_id: projects[0]?.id,
      pmc: pmcs[0]?.name, pmc_employee_id: pmcs[0]?.employeeId, pmc_in_training: false,
      pmc_assignments: pmcs.map((person) => ({ name: person.name, employee_id: person.employeeId })),
      analysis_status: 'completed', workflow_stage: 'project_branches',
      permissions: { manageActions: !readOnly && !meeting.resolution_only, editMeeting: false, deleteActions: false, review: false, assignOrganizer: false },
      available_projects: projects.map((project) => ({ id: project.id, nombre: project.name })),
      assignment_directory: directoryFor(meeting.directory, branch ? [branch] : []),
      actions: scopedActions.map((action) => ({
        ...action, status: action.status || 'pending',
        assignment_directory: directoryFor(meeting.directory.filter((person) => !action.team || person.is_director || person.id === action.responsible_id || action.team.some((member) => member.id === person.id)), meeting.branches.filter((item) => item.project_id === action.project_id)),
      })),
      blockers: { missingResponsible: scopedActions.filter((action) => !action.responsible_id).length, missingDueDate: scopedActions.filter((action) => !action.due_date).length },
      versions: meeting.history.map((entry, index) => ({ id: entry.id || index, stage: 'edición', actor: entry.actor_name || entry.actor_id, created_at: entry.created_at,
        detail: [({ approve: 'Revisión aprobada', return: 'Borrador devuelto', 'action-changed': 'Acción actualizada', 'action-deleted': 'Acción eliminada', 'team-updated': 'Equipo actualizado' })[entry.operation] || entry.operation, entry.detail?.reason].filter(Boolean).join(' · ') })),
    };
  }, [meeting, readOnly, branch]);
  const meetingApi = useMemo(() => ({
    recording: api.projectMeetings.recording,
    updateAction: (id, actionId, form) => api.projectMeetings.saveAction(id, actionId, { title: form.title, due_date: form.due_date || null }),
    addAction: (id, form) => api.projectMeetings.saveAction(id, null, { title: form.title, project_id: form.project_id }),
    assignResponsible: (id, actionId, person) => api.projectMeetings.saveAction(id, actionId, { responsible_id: person.id }),
    removePrimaryResponsible: (id, actionId) => api.projectMeetings.saveAction(id, actionId, { responsible_id: null }),
    deleteAction: api.projectMeetings.deleteAction,
    escalate: api.projectMeetings.escalate,
    manageAdditionalResponsible: api.projectMeetings.manageAdditionalResponsible,
    removeAdditionalResponsible: api.projectMeetings.removeAdditionalResponsible,
  }), []);
  async function workflow(command) {
    if (workflowPending.current || !branch?.can_review) return;
    if (command === 'return' && !returning) { setReturning(true); setError(''); return; }
    const reason = command === 'return' ? returnReason.trim() : '';
    if (command === 'return' && !reason) return;
    workflowPending.current = true;
    setSelectedBranch(branch.id);
    setBusy(true); setError('');
    try { await api.projectMeetings.workflow(meeting.id, { branch_id: branch.id, command, ...(reason ? { reason } : {}) }); setReturning(false); setReturnReason(''); await onChanged(meeting.id); }
    catch (failure) { setError(failure.body || failure.message); }
    finally { workflowPending.current = false; setBusy(false); }
  }
  const branchActions = meeting.actions.filter((action) => action.project_id === branch?.project_id);
  const missing = branchActions.some((action) => !action.responsible_id || !action.due_date);
  const chain = <section className="rounded border border-[#2E2E2E] p-3 text-xs text-[#BFBFBF]">
    {meeting.branches.length > 1 && <label className="mb-2 flex items-center gap-2">Obra en revisión<select aria-label="Rama de revisión" disabled={busy} value={branch?.id || ''} onChange={(event) => { setSelectedBranch(event.target.value); setError(''); setReturning(false); setReturnReason(''); }} className="min-w-0 flex-1 rounded border border-[#2E2E2E] bg-[#141414] p-2">{meeting.branches.map((item) => <option key={item.id} value={item.id}>{item.project_name}{item.approved ? ' · Aprobada' : ''}</option>)}</select></label>}
    {branch && <p className="mb-2 text-amber-100">{branch.project_name} · {branchActions.length} acciones de esta obra</p>}
    <p>{branch ? `Revisor: ${branch.snapshot.path[branch.cursor]?.name || 'Pendiente de asignar'}` : meeting.resolution_only ? 'Vincula la obra para resolver su cadena de revisión.' : 'Dirección: solo acciones asignadas o escaladas.'}</p>
    <p className="mt-1">{branch?.snapshot.path.map((step) => step.cargo).join(' → ') || 'La cadena depende del equipo vinculado al proyecto.'}</p>
    {branch && !branch.snapshot.pmcId && !branch.snapshot.issue && branch.snapshot.path.length > 0 && <p className="mt-1">Sin PMC en esta obra. Cierra {branch.snapshot.path.at(-1).name} como {branch.snapshot.path.at(-1).cargo}, sin cambiar su cargo.</p>}
    {branch?.snapshot.issue && <p className="mt-2 text-amber-200">{branch.snapshot.issue}</p>}
    {meeting.partial_scope && <p className="mt-2 text-[#737373]">Solo se muestra la información de tu ámbito; el resumen conjunto está restringido.</p>}
    {!meeting.partial_scope && meeting.branches.length > 1 && <p className="mt-2 text-[#737373]">Las acciones y la aprobación corresponden a la obra seleccionada. Resumen, decisiones, transcripción e historial son comunes a la reunión.</p>}
  </section>;
  const footer = <footer className="shrink-0 border-t border-[#2E2E2E] bg-[#111111] p-4">
    {error && <p role="alert" className="mb-2 text-xs text-red-200">{error}</p>}
    {returning && !readOnly && branch?.can_review && <form className="mb-3" onSubmit={(event) => { event.preventDefault(); workflow('return'); }}><label className="text-xs text-[#BFBFBF]">Motivo de devolución<textarea autoFocus required value={returnReason} onChange={(event) => setReturnReason(event.target.value)} disabled={busy} className={`${control} mt-1 w-full`} rows={2} /></label><div className="mt-2 flex gap-2"><button disabled={busy || !returnReason.trim()} className="ceo-button-primary rounded px-3 py-2 text-xs disabled:opacity-40">Confirmar devolución</button><button type="button" disabled={busy} className={control} onClick={() => { setReturning(false); setReturnReason(''); }}>Cancelar devolución</button></div></form>}
    <p className={`mb-3 rounded border px-3 py-2 text-xs ${missing && !readOnly ? 'border-amber-300/40 bg-amber-300/[.08] text-amber-100' : 'border-emerald-300/30 bg-emerald-300/[.06] text-emerald-100'}`}>{meeting.resolution_only ? 'Acceso de vinculación: no permite aprobar ni borrar acciones.' : readOnly ? meeting.status === 'approved' ? 'Resultado aprobado e inmutable.' : 'Flujo pausado: solo consulta.' : branch?.approved ? 'Esta rama ya está aprobada por el PMC.' : missing ? 'Aprobación bloqueada: falta responsable o fecha en acciones de esta obra.' : branch?.can_review ? 'Lista para aprobación. Todas las acciones tienen responsable y fecha.' : 'Pendiente del revisor correspondiente.'}</p>
    {!readOnly && branch?.can_review && !returning && <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy || branch.cursor === 0} onClick={() => workflow('return')} className={control}>Devolver</button><button type="button" disabled={busy || missing} onClick={() => workflow('approve')} className="ceo-button-primary rounded px-2 py-2 text-xs font-semibold disabled:opacity-40">{busy ? 'Guardando…' : branch.snapshot.path[branch.cursor]?.final ? 'Aprobar definitivamente' : 'Aprobar y enviar'}</button></div>}
  </footer>;
  return <div ref={container} onKeyDown={keyboard} className="contents"><MeetingReviewDrawer key={branch?.id || meeting.id} meeting={adapted} meetingApi={meetingApi} onClose={onClose} onChanged={onChanged} readOnly={readOnly} projectReview={{ branch, chain, footer }} resolutionPanel={resolution} /></div>;
}
