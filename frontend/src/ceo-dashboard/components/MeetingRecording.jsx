import { useEffect, useState } from 'react';

function displayState(value) {
  const fileId = value.recording_file_id;
  if (value.recording_status === 'available' && typeof fileId === 'string' && /^[A-Za-z0-9_-]{10,255}$/.test(fileId)) return { status: 'available', fileId };
  return { status: value.recording_status === 'none' ? 'none' : 'pending', fileId: null };
}

export default function MeetingRecording({ meeting, loadRecording }) {
  const [state, setState] = useState(() => displayState(meeting));
  const allowed = !meeting.partial_scope && !meeting.resolution_only && meeting.recording_access !== false;
  useEffect(() => {
    setState(displayState(meeting));
    if (!allowed || typeof loadRecording !== 'function' || meeting.recording_status === 'available') return;
    let stopped = false;
    let timer;
    async function refresh() {
      let available = false;
      try {
        const next = displayState(await loadRecording(meeting.id));
        if (stopped) return;
        setState(next);
        available = next.status === 'available';
      } catch {
        if (!stopped) setState(previous => previous.status === 'available' ? previous : { status: 'pending', fileId: null });
      }
      if (!stopped && !available) timer = window.setTimeout(refresh, 30000);
    }
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [meeting.id, meeting.recording_file_id, meeting.recording_status, allowed, loadRecording]);
  if (!allowed) return null;
  return <div className="mt-2" aria-live="polite">
    {state.status === 'available' ? <a href={`https://drive.google.com/file/d/${state.fileId}/view`} target="_blank" rel="noopener noreferrer" title="Abrir en Drive. Se necesitan permisos de acceso al archivo." className="inline-flex items-center gap-2 rounded border border-[#3A3A3A] px-3 py-1.5 text-xs text-[#BFBFBF] hover:text-white">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></svg>Ver vídeo
    </a> : <p className="text-xs text-[#737373]">{state.status === 'none' ? 'Sin grabación' : 'Grabación en proceso'}</p>}
  </div>;
}
