import { BellRing, CalendarClock, CheckCircle2, ClipboardCheck, ExternalLink } from 'lucide-react';

function displayDate(value) {
  if (!value) return 'Sin fecha límite';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Sin fecha límite' : date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Stat({ label, value }) {
  return <div className="dashboard-metric-card rounded-md border border-[#2E2E2E] bg-[#141414] p-4"><p className="font-mono text-[10px] uppercase tracking-[.12em] text-[#737373]">{label}</p><p className="mt-1 text-2xl font-semibold text-[#F2F2F2]">{Number(value || 0)}</p></div>;
}

export default function MyWorkView({ work, loading = false, onOpen, onMarkRead }) {
  const items = work?.items || [];
  const unread = Number(work?.unread || 0);
  return <section className="ceo-page p-4 sm:p-6 xl:p-8">
    <div className="mb-5 flex flex-col gap-3 border-b border-[#2E2E2E] pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-sky-200">Centro personal</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-[#F2F2F2]">Mis pendientes</h2><p className="mt-1 text-xs text-[#737373]">Revisiones y acciones que requieren tu atención.</p></div>
      <div className="flex items-center gap-2 rounded border border-sky-300/30 bg-sky-300/[.06] px-3 py-2 text-xs text-sky-100"><BellRing size={14} />{unread ? `${unread} notificaciones nuevas` : 'Todo revisado'}</div>
    </div>
    <div className="grid gap-3 sm:grid-cols-3"><Stat label="Pendientes" value={work?.total || 0} /><Stat label="Revisiones" value={work?.reviews || 0} /><Stat label="Acciones asignadas" value={work?.actions || 0} /></div>
    <div className="mt-5 overflow-hidden rounded-md border border-[#2E2E2E] bg-[#141414]">
      <div className="border-b border-[#2E2E2E] px-4 py-3"><p className="text-sm font-medium text-[#F2F2F2]">Bandeja de trabajo</p><p className="mt-1 text-[11px] text-[#737373]">Al abrir un elemento se muestra su reunión y se marca la notificación como leída.</p></div>
      {loading && <p className="px-4 py-8 text-center text-xs text-[#737373]">Cargando tus pendientes…</p>}
      {!loading && !items.length && <div className="px-4 py-12 text-center"><CheckCircle2 className="mx-auto text-emerald-300" size={26} /><p className="mt-3 text-sm font-medium text-[#F2F2F2]">No tienes pendientes</p><p className="mt-1 text-xs text-[#737373]">Cuando te asignen una acción o una revisión aparecerá aquí.</p></div>}
      <div className="divide-y divide-[#2E2E2E]">{items.map((item) => <button key={item.key} type="button" onClick={() => { void onMarkRead?.([item.key]); onOpen?.(item); }} className="group flex w-full items-start gap-3 px-4 py-4 text-left hover:bg-[#0D0D0D]">
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded border ${item.kind === 'review' ? 'border-violet-300/35 bg-violet-300/[.08] text-violet-200' : 'border-amber-300/35 bg-amber-300/[.08] text-amber-100'}`}>{item.kind === 'review' ? <ClipboardCheck size={15} /> : <CalendarClock size={15} />}</span>
        <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-medium text-[#F2F2F2]">{item.title}</span>{item.unread && <span className="size-1.5 shrink-0 rounded-full bg-sky-300" title="Nueva" />}</span><span className="mt-1 block text-xs text-[#BFBFBF]">{item.detail}</span><span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#737373]"><span className="text-sky-200">{item.meetingName}</span>{item.projectName && <span>{item.projectName}</span>}{item.kind === 'action' && <span className="text-amber-100">{displayDate(item.dueDate)}</span>}</span></span>
        <ExternalLink size={14} className="mt-1 shrink-0 text-[#4A4A4A] group-hover:text-sky-200" />
      </button>)}</div>
    </div>
  </section>;
}
