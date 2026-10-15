import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, MessageCircle } from 'lucide-react';
import api from '../api';
import { callListQuery, clearCallFilters, DEFAULT_CALL_FILTERS, formatDuration, formatMadridDateTime, formatOffset, formatPhone, readCallFilters, writeCallFilters } from '../netelipFormat';

const CONTACT_THEME = {
  client: { label: 'Cliente', className: 'border-emerald-300/40 bg-emerald-300/[.08] text-emerald-100' },
  lead: { label: 'Lead', className: 'border-amber-300/40 bg-amber-300/[.08] text-amber-100' },
};
const TRANSCRIPTION_LABEL = { completed: 'Completada', pending: 'Pendiente', failed: 'Fallida' };
const TRANSCRIPTION_TONE = { completed: 'text-emerald-200', pending: 'text-amber-200', failed: 'text-red-200' };
const selectClass = 'h-8 max-w-52 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-amber-300/50';

/** Estado de la transcripción con barra de avance mientras el motor trabaja. */
function TranscriptionStatus({ call, wide = false }) {
  const status = call.transcription_status;
  if (status === 'pending' && call.transcription_phase === 'processing') {
    const percent = Math.max(0, Math.min(100, Number(call.transcription_progress) || 0));
    return <div className={wide ? 'w-full' : 'w-28'}><p className="text-xs text-amber-200">Transcribiendo · {percent} %</p><div role="progressbar" aria-label="Avance de la transcripción" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 h-1 overflow-hidden rounded bg-[#2E2E2E]"><div className="h-full rounded bg-amber-300 transition-all duration-700" style={{ width: `${Math.max(percent, 3)}%` }} /></div></div>;
  }
  if (status === 'pending') return <p className="text-xs text-amber-200">En cola</p>;
  return <p className={`text-xs ${TRANSCRIPTION_TONE[status] || 'text-[#737373]'}`}>{TRANSCRIPTION_LABEL[status] || 'Sin transcripción'}</p>;
}

function ContactPill({ type }) {
  const theme = CONTACT_THEME[type];
  return theme ? <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${theme.className}`}>{theme.label}</span> : null;
}

function DirectionCell({ call }) {
  const outbound = call.direction === 'outbound';
  const Icon = outbound ? ArrowUpRight : ArrowDownLeft;
  return <div className="flex items-center gap-2 text-xs text-[#F2F2F2]"><Icon size={14} className={outbound ? 'text-amber-200' : 'text-emerald-200'} aria-hidden="true" /><span>{outbound ? 'Saliente' : 'Entrante'}</span>{call.via === 'whatsapp' && <span title="Llamada de WhatsApp" className="inline-flex items-center gap-1 rounded-full border border-emerald-300/40 px-1.5 py-0.5 text-[9px] text-emerald-100"><MessageCircle size={10} aria-hidden="true" />WhatsApp</span>}</div>;
}

/** Contacto de la fila: lead o cliente con enlace a su ficha, o el motivo por el que no hay contacto. */
function ContactCell({ call, onOpenContact }) {
  if (call.contact) {
    return <div><button type="button" onClick={(event) => { event.stopPropagation(); onOpenContact(call.contact); }} className="text-left text-xs font-medium text-[#F2F2F2] underline decoration-[#4A4A4A] underline-offset-2 hover:decoration-amber-300">{call.contact.name}</button><div className="mt-1"><ContactPill type={call.contact.type} /></div></div>;
  }
  if (call.contact_status === 'hidden') return <div><p className="text-xs text-[#BFBFBF]">Sin contacto identificado</p><p className="mt-1 text-[10px] text-[#737373]">Número oculto</p></div>;
  if (call.contact_status === 'multiple') return <div><p className="text-xs text-[#BFBFBF]">Sin contacto identificado</p><p className="mt-1 text-[10px] text-amber-200">Coincidencia múltiple</p></div>;
  return <div><p className="text-xs text-[#BFBFBF]">Sin contacto identificado</p><p className="mt-1 text-[10px] text-[#737373]">Pendiente de resolución</p></div>;
}

function speakerLabel(speaker) {
  const value = String(speaker || '').toLowerCase();
  if (['agent', 'agente'].includes(value)) return 'GRUPO LYN';
  if (['customer', 'cliente'].includes(value)) return 'CLIENTE';
  const index = value.match(/(\d+)$/);
  return index ? `Hablante ${Number(index[1]) + 1}` : '';
}

function TranscriptionPanel({ detail }) {
  const transcription = detail.transcription;
  if (detail.transcription_access === 'denied') return <p role="status" className="rounded border border-amber-300/30 bg-amber-300/[.06] p-3 text-xs leading-5 text-amber-100">No tienes permiso para leer transcripciones. Solo los roles autorizados por Producto pueden ver el texto de las llamadas.</p>;
  if (!transcription) return <p className="rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs text-[#737373]">Esta llamada no tiene transcripción disponible.</p>;
  if (transcription.status === 'pending') return <div role="status" className="rounded border border-amber-300/30 bg-amber-300/[.06] p-3 text-xs leading-5 text-amber-100"><p>{detail.call?.transcription_phase === 'processing' ? 'Transcribiendo el audio de la llamada. El texto aparecerá aquí al terminar.' : 'Transcripción pendiente: la llamada está en cola. El texto aparecerá aquí en cuanto el motor termine.'}</p>{detail.call?.transcription_phase === 'processing' && <div className="mt-3"><TranscriptionStatus call={detail.call} wide /></div>}</div>;
  if (transcription.status === 'failed') return <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-3 text-xs leading-5 text-red-200">No se pudo transcribir esta llamada tras varios intentos. El equipo de tecnología ya está avisado.</p>;
  const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
  if (!String(transcription.text || '').trim() && !segments.length) return <p className="rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs text-[#737373]">La grabación no contiene conversación: solo el aviso de grabación o silencio.</p>;
  if (!segments.length) return <p className="whitespace-pre-wrap rounded border border-[#2E2E2E] bg-[#141414] p-3 text-xs leading-6 text-[#D4D4D4]">{transcription.text}</p>;
  return <ol className="space-y-2">{segments.map((segment, index) => {
    const label = speakerLabel(segment.speaker);
    return <li key={`${segment.start}-${index}`} className="grid grid-cols-[52px_1fr] gap-2 rounded border border-[#2E2E2E] bg-[#141414] p-2.5"><span className="font-mono text-[10px] text-[#737373]">{formatOffset(segment.start)}</span><p className="text-xs leading-5 text-[#D4D4D4]">{label && <span className={`mr-1.5 font-mono text-[10px] font-semibold tracking-[.08em] ${label === 'GRUPO LYN' ? 'text-amber-200' : 'text-emerald-200'}`}>{label}:</span>}{segment.text}</p></li>;
  })}</ol>;
}

function CallDrawer({ detail, loading, error, onClose, onOpenContact }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const call = detail?.call;
  const title = call?.contact?.name || 'Sin contacto identificado';
  return <aside role="dialog" aria-modal="true" aria-label="Detalle de llamada" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[600px] flex-col border-l border-[#2E2E2E] bg-[#0D0D0D] shadow-2xl">
    <header className="shrink-0 border-b border-[#2E2E2E] bg-[#111111] px-5 py-5"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="font-mono text-[10px] uppercase tracking-[.14em] text-[#737373]">Llamada grabada</p><h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-[#F2F2F2]">{loading && !call ? 'Cargando…' : title}</h2>{call && <div className="mt-2 flex flex-wrap items-center gap-2"><ContactPill type={call.contact?.type} />{call.contact && <button type="button" onClick={() => onOpenContact(call.contact)} className="text-[11px] text-amber-300 hover:text-amber-200">Ver ficha</button>}{!call.contact && <span className="text-[11px] text-[#737373]">{call.contact_status === 'hidden' ? 'Número oculto' : call.contact_status === 'multiple' ? 'Coincidencia múltiple: el teléfono pertenece a varios contactos' : 'Pendiente de resolución'}</span>}</div>}</div><button type="button" onClick={onClose} className="shrink-0 rounded border border-[#2E2E2E] px-2.5 py-1.5 text-xs text-[#BFBFBF] hover:border-[#737373]">Cerrar</button></div></header>
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
      {call && <>
        <dl className="grid grid-cols-2 gap-3 rounded-md border border-[#2E2E2E] bg-[#141414] p-4 text-xs">
          {[['Teléfono', call.contact_status === 'hidden' ? 'Número oculto' : formatPhone(call.phone)], ['Dirección', <DirectionCell key="d" call={call} />], ['Agente', call.agent ? call.agent.name || `Extensión ${call.agent.extension}` : '—'], ['Fecha', formatMadridDateTime(call.occurred_at)], ['Duración', formatDuration(call.duration_seconds)], ['Canal', call.via === 'whatsapp' ? 'WhatsApp' : 'Teléfono (Netelip)']].map(([label, value]) => <div key={label}><dt className="font-mono text-[10px] uppercase tracking-[.12em] text-[#737373]">{label}</dt><dd className="mt-1 text-[#F2F2F2]">{value}</dd></div>)}
        </dl>
        <section className="mt-5"><h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.14em] text-[#737373]">Transcripción</h3><TranscriptionPanel detail={detail} /></section>
      </>}
    </div>
  </aside>;
}

export default function NetelipCallsView({ onOpenContact = () => {} }) {
  const [filters, setFilters] = useState(() => readCallFilters(window.location.search));
  const [result, setResult] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [search, setSearch] = useState(filters.q);

  const update = (changes) => setFilters((current) => ({ ...current, page: 1, ...changes }));

  // Filtros y llamada abierta en la URL: se puede copiar y abrir en otra pestaña.
  useEffect(() => {
    window.history.replaceState({}, '', writeCallFilters(new URL(window.location.href), filters));
  }, [filters]);
  useEffect(() => () => { window.history.replaceState({}, '', clearCallFilters(new URL(window.location.href))); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { if (search !== filters.q) update({ q: search }); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const { call: _openCall, ...listFilters } = filters;
  const listKey = JSON.stringify(listFilters);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await api.netelip.calls(callListQuery(listFilters));
        if (active) { setResult(data); setError(''); }
      } catch (requestError) {
        if (active) setError(requestError.body || requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [listKey]);
  useEffect(() => { void api.netelip.filterOptions().then((data) => setAgents(data?.agents || [])).catch(() => setAgents([])); }, []);

  useEffect(() => {
    if (!filters.call) { setDetail(null); return undefined; }
    let active = true;
    setDetailLoading(true); setDetailError('');
    const load = () => api.netelip.call(filters.call).then((data) => { if (active) setDetail(data); }).catch((requestError) => { if (active) setDetailError(requestError.body || requestError.message); }).finally(() => { if (active) setDetailLoading(false); });
    void load();
    // Mientras la transcripción esté pendiente, el panel se actualiza solo (más a menudo si está transcribiendo).
    const timer = window.setInterval(() => { void load(); }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [filters.call]);

  const openCall = (id) => setFilters((current) => ({ ...current, call: String(id) }));
  const closeCall = () => setFilters((current) => ({ ...current, call: '' }));
  const clearFilters = () => { setSearch(''); setFilters({ ...DEFAULT_CALL_FILTERS, dir: filters.dir }); };
  const filtersActive = Boolean(filters.via || filters.agent || filters.contact || filters.tr || filters.period || filters.q || filters.sort !== 'recent');
  const items = result?.items || [];
  const total = result?.total || 0;
  const page = result?.page || filters.page;
  const pageSize = result?.pageSize || 25;
  const totalPages = result?.totalPages || 1;
  const metrics = result?.metrics || { calls: 0, unidentified: 0, transcription_pending: 0, transcription_failed: 0 };
  const noCallsAtAll = !loading && !error && total === 0 && metrics.calls === 0 && !filtersActive && !filters.dir;
  const kpis = [
    { label: 'Llamadas del periodo', value: metrics.calls, active: !filters.contact && !filters.tr, apply: { contact: '', tr: '' } },
    { label: 'Sin contacto identificado', value: metrics.unidentified, active: filters.contact === 'unidentified', apply: { contact: 'unidentified', tr: '' } },
    { label: 'Transcripciones pendientes', value: metrics.transcription_pending, active: filters.tr === 'pending', apply: { tr: 'pending', contact: '' } },
    { label: 'Transcripciones fallidas', value: metrics.transcription_failed, active: filters.tr === 'failed', apply: { tr: 'failed', contact: '' } },
  ];

  return <section className="ceo-page p-4 sm:p-6 xl:p-8">
    <div className="mb-5 flex flex-col gap-3 border-b border-[#2E2E2E] pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#737373]">Netelip</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-[#F2F2F2]">Historial de llamadas</h2><p className="mt-1 text-xs text-[#737373]">Llamadas grabadas del equipo con clientes y contactos, con su transcripción. Horas de Madrid.</p></div>
      <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar llamadas" placeholder="Buscar por nombre o teléfono…" className="h-9 w-72 max-w-full ceo-surface rounded border border-[#2E2E2E] bg-[#141414] px-3 text-xs text-[#F2F2F2] outline-none" />
    </div>
    {error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{kpis.map((kpi) => <button key={kpi.label} type="button" onClick={() => update(kpi.apply)} aria-pressed={kpi.active} className={`dashboard-metric-card rounded-md border bg-[#141414] p-4 text-left ${kpi.active ? 'border-amber-300/50' : 'border-[#2E2E2E] hover:border-[#4A4A4A]'}`}><p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]">{kpi.label}</p><p className="mt-1 text-2xl font-semibold text-[#F2F2F2]">{loading && !result ? '—' : kpi.value}</p></button>)}</div>
    <div className="mt-5 overflow-hidden rounded-md border border-[#2E2E2E] bg-[#141414]">
      <div className="border-b border-[#2E2E2E] px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[['', 'Todas'], ['inbound', 'Entrantes'], ['outbound', 'Salientes']].map(([key, label]) => <button key={label} type="button" onClick={() => update({ dir: key })} className={`dashboard-filter-tab rounded px-3 py-1.5 text-xs ${filters.dir === key ? 'is-active bg-[#2E2E2E] text-[#F2F2F2]' : 'text-[#737373]'}`}>{label}</button>)}
          <span className="mx-1 hidden h-6 w-px bg-[#2E2E2E] sm:block" />
          <select aria-label="Filtrar por agente" value={filters.agent} onChange={(event) => update({ agent: event.target.value })} className={selectClass}><option value="">Agente</option>{agents.map((agent) => <option key={agent.extension} value={agent.extension}>{agent.name ? `${agent.name} · ${agent.extension}` : `Extensión ${agent.extension}`}</option>)}</select>
          <select aria-label="Filtrar por contacto" value={filters.contact} onChange={(event) => update({ contact: event.target.value })} className={selectClass}><option value="">Contacto</option><option value="identified">Identificado</option><option value="unidentified">Sin identificar</option></select>
          <select aria-label="Filtrar por transcripción" value={filters.tr} onChange={(event) => update({ tr: event.target.value })} className={selectClass}><option value="">Transcripción</option><option value="completed">Completada</option><option value="pending">Pendiente</option><option value="failed">Fallida</option></select>
          <select aria-label="Filtrar por canal" value={filters.via} onChange={(event) => update({ via: event.target.value })} className={selectClass}><option value="">Canal</option><option value="phone">Teléfono</option><option value="whatsapp">WhatsApp</option></select>
          <span className="mx-1 hidden h-6 w-px bg-[#2E2E2E] md:block" />
          <select aria-label="Filtrar por fecha" value={filters.period} onChange={(event) => update({ period: event.target.value, ...(event.target.value === 'custom' ? {} : { from: '', to: '' }) })} className={selectClass}><option value="">Fecha</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option><option value="custom">Rango de fechas…</option></select>
          <select aria-label="Ordenar llamadas" value={filters.sort} onChange={(event) => update({ sort: event.target.value })} className={selectClass}><option value="recent">Más recientes</option><option value="oldest">Más antiguas</option><option value="longest">Más largas</option></select>
          <button type="button" onClick={clearFilters} disabled={!filtersActive} className="h-8 rounded border border-transparent px-2 text-xs text-[#737373] hover:border-[#2E2E2E] hover:text-[#F2F2F2] disabled:opacity-40">Limpiar</button>
        </div>
        {filters.period === 'custom' && <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-[#2E2E2E] pt-3"><label className="text-[10px] text-[#737373]">Desde<input type="date" value={filters.from} onChange={(event) => update({ from: event.target.value })} className="ml-2 h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#F2F2F2] outline-none" /></label><label className="text-[10px] text-[#737373]">Hasta<input type="date" value={filters.to} onChange={(event) => update({ to: event.target.value })} className="ml-2 h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#F2F2F2] outline-none" /></label></div>}
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left"><thead className="bg-[#0D0D0D] font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]"><tr><th className="px-3 py-3">Fecha</th><th className="px-3 py-3">Dirección</th><th className="px-3 py-3">Contacto</th><th className="px-3 py-3">Teléfono</th><th className="px-3 py-3">Agente</th><th className="px-3 py-3">Duración</th><th className="px-3 py-3">Transcripción</th></tr></thead>
        <tbody className="divide-y divide-[#2E2E2E]">
          {items.map((call) => <tr key={call.id} onClick={() => openCall(call.id)} aria-selected={String(call.id) === filters.call} className={`group cursor-pointer hover:bg-[#0D0D0D] ${String(call.id) === filters.call ? 'bg-[#0D0D0D]' : ''}`}>
            <td className="border-l-2 border-l-transparent px-3 py-3 font-mono text-xs text-[#F2F2F2] group-hover:border-l-amber-300">{formatMadridDateTime(call.occurred_at)}</td>
            <td className="px-3 py-3"><DirectionCell call={call} /></td>
            <td className="px-3 py-3"><ContactCell call={call} onOpenContact={onOpenContact} /></td>
            <td className="px-3 py-3 font-mono text-xs text-[#BFBFBF]">{call.contact_status === 'hidden' ? 'Oculto' : formatPhone(call.phone)}</td>
            <td className="px-3 py-3 text-xs text-[#BFBFBF]">{call.agent ? <><p>{call.agent.name || `Extensión ${call.agent.extension}`}</p>{call.agent.name && <p className="mt-1 text-[10px] text-[#737373]">Ext. {call.agent.extension}</p>}</> : '—'}</td>
            <td className="px-3 py-3 font-mono text-xs text-[#BFBFBF]">{formatDuration(call.duration_seconds)}</td>
            <td className="px-3 py-3"><TranscriptionStatus call={call} /></td>
          </tr>)}
          {loading && !result && <tr><td colSpan="7" className="px-3 py-12 text-center text-xs text-[#737373]" role="status">Cargando llamadas…</td></tr>}
          {noCallsAtAll && <tr><td colSpan="7" className="px-3 py-12 text-center text-xs text-[#737373]">Todavía no hay llamadas grabadas. Aparecerán aquí cuando Netelip envíe la primera grabación.</td></tr>}
          {!loading && !error && !items.length && !noCallsAtAll && <tr><td colSpan="7" className="px-3 py-12 text-center text-xs text-[#737373]">No hay llamadas que coincidan con los filtros.{filtersActive && <button type="button" onClick={clearFilters} className="ml-2 text-amber-300 hover:text-amber-200">Limpiar filtros</button>}</td></tr>}
        </tbody></table></div>
      <div className="flex flex-col gap-3 border-t border-[#2E2E2E] px-3 py-3 text-xs text-[#737373] sm:flex-row sm:items-center sm:justify-between"><p>Mostrando {total ? ((page - 1) * pageSize) + 1 : 0}–{Math.min(page * pageSize, total)} de {total} llamadas</p><div className="flex items-center gap-2"><button type="button" disabled={page <= 1 || loading} onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, page - 1) }))} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[#BFBFBF] hover:border-amber-300/50 disabled:cursor-not-allowed disabled:opacity-40">Anterior</button><span className="min-w-24 text-center">Página {page} de {Math.max(1, totalPages)}</span><button type="button" disabled={page >= totalPages || loading} onClick={() => setFilters((current) => ({ ...current, page: Math.min(totalPages, page + 1) }))} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-[#BFBFBF] hover:border-amber-300/50 disabled:cursor-not-allowed disabled:opacity-40">Siguiente</button></div></div>
    </div>
    {filters.call && <><button type="button" aria-label="Cerrar detalle" onClick={closeCall} className="fixed inset-0 z-40 bg-black/60" /><CallDrawer detail={detail} loading={detailLoading} error={detailError} onClose={closeCall} onOpenContact={onOpenContact} /></>}
  </section>;
}
