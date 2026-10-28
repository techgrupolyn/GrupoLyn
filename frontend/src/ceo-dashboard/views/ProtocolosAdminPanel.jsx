import { useEffect, useState } from 'react';
import { BarChart3, ChevronDown, Clock3, FileText, History, MessageCircle } from 'lucide-react';
import api from '../api';
import { protocolReportCsv } from '../protocol-report-csv';

const today = new Date();
const firstDay = new Date(today);
firstDay.setUTCDate(firstDay.getUTCDate() - 6);
const initialFilters = { from: firstDay.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10), area: '', role: '', minCount: 3 };
const fieldClass = 'rounded-lg border border-[#35332F] bg-[#171614] px-3 py-2 text-sm text-[#F2F2F2] outline-none transition-colors focus:border-[#C3A86A]';

function exportSection(rows, section) {
  const blob = new Blob([protocolReportCsv(rows, section)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `protocolos-${section}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ProtocolosAdminPanel({ refreshToken }) {
  const [activeTab, setActiveTab] = useState('history');
  const [filters, setFilters] = useState(initialFilters);
  const [report, setReport] = useState(null);
  const [queries, setQueries] = useState([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadReport = async (nextFilters) => {
    setBusy(true);
    setError('');
    try { setReport(await api.protocols.report(nextFilters)); }
    catch (requestError) { setError(requestError.body || requestError.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { void loadReport(filters); }, [refreshToken]);
  useEffect(() => {
    let active = true;
    setHistoryLoading(true);
    api.protocols.queries(offset).then(result => {
      if (!active) return;
      const nextTotal = Number(result.total) || 0;
      const nextPageSize = Number(result.limit) || 10;
      if (nextTotal && offset >= nextTotal) {
        setOffset(Math.floor((nextTotal - 1) / nextPageSize) * nextPageSize);
        return;
      }
      setQueries(result.items || []);
      setTotal(nextTotal);
      setPageSize(nextPageSize);
    }).catch(requestError => { if (active) setError(requestError.body || requestError.message); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [offset, refreshToken]);

  const update = (field, value) => setFilters(current => ({ ...current, [field]: value }));

  return <section className="overflow-hidden rounded-2xl border border-[#34312B] bg-[#141310] text-sm text-[#F2F2F2] shadow-[0_18px_45px_rgba(0,0,0,0.18)]">
    <div className="border-b border-[#34312B] bg-[linear-gradient(125deg,#242018_0%,#181713_52%,#141310_100%)] px-5 py-6 sm:px-7">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[#C3A86A]">Seguimiento del agente</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-display text-2xl">Consultas del equipo</h3><p className="mt-2 max-w-xl text-xs leading-relaxed text-[#A9A59C]">Revisa las preguntas, respuestas y temas que necesitan atención. Acceso exclusivo para Dirección y Superadmin.</p></div>
        <span className="rounded-full border border-[#6C5B39] bg-[#C3A86A]/10 px-3 py-1 text-xs font-medium text-[#E1C88F]">{total} {total === 1 ? 'consulta' : 'consultas'}</span>
      </div>
    </div>
    <div className="flex gap-6 border-b border-[#34312B] px-5 sm:px-7" role="tablist" aria-label="Consultas del equipo">
      <button type="button" role="tab" aria-selected={activeTab === 'history'} onClick={() => setActiveTab('history')} className={`flex items-center gap-2 border-b-2 py-4 text-sm transition-colors ${activeTab === 'history' ? 'border-[#C3A86A] font-semibold text-[#F2F2F2]' : 'border-transparent text-[#96928A] hover:text-[#F2F2F2]'}`}><History size={16} />Historial</button>
      <button type="button" role="tab" aria-selected={activeTab === 'report'} onClick={() => setActiveTab('report')} className={`flex items-center gap-2 border-b-2 py-4 text-sm transition-colors ${activeTab === 'report' ? 'border-[#C3A86A] font-semibold text-[#F2F2F2]' : 'border-transparent text-[#96928A] hover:text-[#F2F2F2]'}`}><BarChart3 size={16} />Informe de 7 días</button>
    </div>
    {activeTab === 'report' && <div role="tabpanel" className="space-y-5 p-5 sm:p-7">
      <div><h4 className="font-display text-xl">Temas y respuestas</h4><p className="mt-1 text-xs text-[#A9A59C]">Filtra el periodo y descarga los resultados para analizarlos.</p></div>
      <form onSubmit={event => { event.preventDefault(); void loadReport(filters); }} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">Desde<input aria-label="Desde" type="date" value={filters.from} onChange={event => update('from', event.target.value)} className={fieldClass} required /></label>
        <label className="grid gap-1 text-xs">Hasta<input aria-label="Hasta" type="date" value={filters.to} onChange={event => update('to', event.target.value)} className={fieldClass} required /></label>
        <label className="grid gap-1 text-xs">Área<select aria-label="Área" value={filters.area} onChange={event => update('area', event.target.value)} className={fieldClass}><option value="">Todas</option>{['diseno', 'presupuestos', 'materiales', 'obra', 'revisiones_y_reuniones', 'responsables_y_escalado', 'uso_de_club_lyn', 'otro'].map(area => <option key={area} value={area}>{area.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Cargo<input aria-label="Cargo" value={filters.role} onChange={event => update('role', event.target.value)} className={fieldClass} placeholder="Todos" /></label>
        <label className="grid gap-1 text-xs">Mínimo de consultas<input aria-label="Mínimo de consultas" type="number" min="1" max="100" value={filters.minCount} onChange={event => update('minCount', event.target.value)} className={`${fieldClass} w-24`} /></label>
        <button type="submit" disabled={busy} className="rounded-lg border border-[#C3A86A] bg-[#C3A86A] px-4 py-2 text-sm font-semibold text-[#181610] transition-colors hover:bg-[#D7BE84] disabled:opacity-50">{busy ? 'Cargando…' : 'Aplicar filtros'}</button>
      </form>
      {report && <div className="space-y-6">
        <div className="rounded-xl border border-[#34312B] bg-[#1B1915] p-4"><div className="mb-3 flex items-center justify-between gap-3"><h5 className="font-semibold">Temas más consultados</h5><button type="button" onClick={() => exportSection(report.popular, 'popular')} className="rounded-lg border border-[#51452F] px-3 py-1.5 text-xs text-[#E1C88F] hover:bg-[#C3A86A]/10">Exportar CSV</button></div>
          {report.popular.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-[#333]"><th className="p-2">Tema</th><th className="p-2">Consultas</th><th className="p-2">Personas</th><th className="p-2">Resueltas</th><th className="p-2">Documento más citado</th><th className="p-2">Última consulta</th></tr></thead><tbody>{report.popular.map(row => <tr key={row.tema} className="border-b border-[#292929]"><td className="p-2">{row.tema}</td><td className="p-2">{row.consultas}</td><td className="p-2">{row.usuarios}</td><td className="p-2">{row.porcentaje_resueltas == null ? '—' : `${row.porcentaje_resueltas} %`}</td><td className="p-2">{row.documento_mas_citado || '—'}</td><td className="p-2">{new Date(row.ultima_consulta).toLocaleDateString('es-ES')}</td></tr>)}</tbody></table></div> : <p className="text-xs text-[#BFBFBF]">No hay temas que alcancen el mínimo en este periodo.</p>}</div>
        <div className="rounded-xl border border-[#34312B] bg-[#1B1915] p-4"><div className="mb-3 flex items-center justify-between gap-3"><h5 className="font-semibold">Temas sin respuesta</h5><button type="button" onClick={() => exportSection(report.unanswered, 'unanswered')} className="rounded-lg border border-[#51452F] px-3 py-1.5 text-xs text-[#E1C88F] hover:bg-[#C3A86A]/10">Exportar CSV</button></div>
          {report.unanswered.length ? <ul className="space-y-2">{report.unanswered.map(row => <li key={row.tema} className="rounded border border-[#333] p-3"><details><summary className="cursor-pointer font-medium">{row.tema} · {row.consultas} sin resolver</summary><p className="mt-2 text-xs text-[#BFBFBF]">Sin protocolo: {row.sin_protocolo} · Fuera de alcance: {row.fuera_de_alcance} · Tema sensible: {row.tema_sensible} · Rechazadas: {row.rechazadas} · Usuario indicó No: {row.usuario_dijo_no}</p><p className="mt-1 text-xs text-[#BFBFBF]">Cargos: {(row.cargos || []).join(', ') || '—'}</p><ul className="mt-2 list-inside list-disc text-xs text-[#BFBFBF]">{(row.ejemplos || []).map((example, index) => <li key={index}>{example}</li>)}</ul></details></li>)}</ul> : <p className="text-xs text-[#BFBFBF]">No hay consultas sin respuesta en este periodo.</p>}</div>
      </div>}
    </div>}
    {activeTab === 'history' && <div role="tabpanel" className="space-y-5 p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-display text-xl">Historial de consultas</h4><p className="mt-1 text-xs text-[#A9A59C]">Abre una pregunta para leer la respuesta completa del agente.</p></div><span className="rounded-lg border border-[#34312B] bg-[#1B1915] px-3 py-1.5 text-xs text-[#A9A59C]">10 por página</span></div>
      {historyLoading && <p role="status" className="text-xs text-[#BFBFBF]">Cargando consultas…</p>}
      {!historyLoading && (queries.length ? <ul className="max-h-[32rem] space-y-3 overflow-y-auto pr-2">{queries.map(item => <li key={item.id}><details className="group overflow-hidden rounded-xl border border-[#37332B] bg-[#1C1A16] transition-colors open:border-[#8A7448] open:bg-[#221F19]"><summary className="flex cursor-pointer list-none items-start gap-3 p-4 sm:p-5 [&::-webkit-details-marker]:hidden"><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#51452F] bg-[#C3A86A]/10 text-[#D7BE84]"><MessageCircle size={16} /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#A9A59C]"><Clock3 size={12} />{new Date(item.creado_en).toLocaleString('es-ES')}<span>· {item.cargo}</span><span className="rounded-full border border-[#51452F] px-2 py-0.5 text-[#D7BE84]">{item.clasificacion}</span></span><span className="mt-2 block text-sm font-medium leading-relaxed text-[#F2F2F2]">{item.pregunta}</span></span><ChevronDown size={17} className="mt-2 shrink-0 text-[#A9A59C] transition-transform group-open:rotate-180" /></summary><div className="space-y-4 border-t border-[#37332B] px-4 pb-5 pt-4 sm:px-5"><div className="border-l-2 border-[#8A7448] pl-3"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#D7BE84]">Consulta realizada</p><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#D7D4CE]">{item.pregunta}</p></div><div className="rounded-xl border border-[#37332B] bg-[#151410] p-4"><p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#D7BE84]"><FileText size={14} />Respuesta del agente</p><p className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-[#E4E1DA]">{item.respuesta}</p></div><p className="text-[11px] leading-relaxed text-[#8F8B83]">Validación: {item.validacion} · Fuentes: {(item.fuentes || []).map(source => `${source.name || source.doc_id} (${source.seccion})`).join(', ') || 'ninguna'}</p></div></details></li>)}</ul> : <div className="rounded-xl border border-dashed border-[#4A4234] bg-[#1B1915] px-5 py-10 text-center"><MessageCircle size={22} className="mx-auto mb-3 text-[#8A7448]" /><p className="font-medium">Aún no hay consultas</p><p className="mt-1 text-xs text-[#A9A59C]">Cuando el equipo pregunte al agente, aparecerán aquí.</p></div>)}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#34312B] pt-4 text-xs"><span className="text-[#A9A59C]">Página {Math.floor(offset / pageSize) + 1} de {Math.max(1, Math.ceil(total / pageSize))} · {total} consultas</span><div className="flex gap-2"><button type="button" disabled={historyLoading || !offset} onClick={() => setOffset(current => Math.max(0, current - pageSize))} className="rounded-lg border border-[#51452F] px-3 py-2 text-[#E1C88F] hover:bg-[#C3A86A]/10 disabled:opacity-40">Anterior</button><button type="button" disabled={historyLoading || offset + pageSize >= total} onClick={() => setOffset(current => current + pageSize)} className="rounded-lg border border-[#51452F] px-3 py-2 text-[#E1C88F] hover:bg-[#C3A86A]/10 disabled:opacity-40">Siguiente</button></div></div>
    </div>}
    {error && <p role="alert" className="px-5 pb-5 text-xs text-red-200 sm:px-7">{error}</p>}
  </section>;
}
