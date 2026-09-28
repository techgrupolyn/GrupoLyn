import { useEffect, useState } from 'react';
import api from '../api';

export default function MeetingImportIssue({ issue, canAssign, onClose, onChanged }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detection, setDetection] = useState('');
  const detect = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.meetings.detectOrganizer(issue.artifactId);
      setDetection(result.linked ? 'Organizador vinculado. La incidencia aparece en sus notificaciones.' : result.reason);
      if (result.linked) await onChanged();
    } catch (failure) { setError(failure.body || failure.message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!canAssign) return;
    let active = true;
    api.directory.overview().then((data) => { if (active) setEmployees(data.employees || []); }).catch(() => { if (active) setError('No se pudo cargar el directorio.'); });
    return () => { active = false; };
  }, [canAssign]);
  const assign = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.meetings.setOrganizer(issue.artifactId, employeeId); await onChanged(); onClose(); }
    catch (failure) { setError(failure.body || failure.message); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <section role="dialog" aria-modal="true" aria-label="Incidencia de importación" className="w-full max-w-lg rounded border border-amber-300/30 bg-[#141414] p-5 text-[#F2F2F2]">
      <div className="flex justify-between gap-4"><h2 className="font-semibold">{issue.title}</h2><button aria-label="Cerrar incidencia" onClick={onClose}>✕</button></div>
      <p className="mt-3 text-sm">{issue.meetingName}</p><p className="mt-2 text-xs text-amber-100">{issue.detail}</p>
      <p className="mt-3 text-xs text-[#aaa]">Revisa el documento fuente y sus permisos en Drive. No se creó un borrador utilizable ni se inventó un resumen.</p>
      {canAssign && <button type="button" disabled={busy} onClick={detect} className="mt-3 rounded border border-amber-300/40 px-3 py-2 text-xs disabled:opacity-40">Detectar organizador en Calendar</button>}
      {detection && <p role="status" className="mt-2 text-xs text-amber-100">{detection}</p>}
      {canAssign && <form onSubmit={assign} className="mt-4 space-y-3"><label className="block text-xs">Vincular al organizador real<select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="mt-2 w-full rounded border border-[#444] bg-[#0D0D0D] p-2"><option value="">Seleccionar empleado…</option>{employees.filter((employee) => employee.activo !== false).map((employee) => <option key={employee.id} value={employee.id}>{[employee.nombre, employee.apellido].filter(Boolean).join(' ')}</option>)}</select></label><p className="text-[11px] text-[#999]">Solo selecciona a quien organizó la reunión. Recibirá esta incidencia en sus notificaciones del dashboard.</p><button disabled={busy} className="rounded border border-[#555] px-3 py-2 text-xs disabled:opacity-40">{busy ? 'Guardando…' : 'Vincular y notificar'}</button></form>}
      {error && <p role="alert" className="mt-3 text-xs text-red-200">{error}</p>}
    </section>
  </div>;
}
