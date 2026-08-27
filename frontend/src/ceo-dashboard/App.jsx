import { useEffect, useRef, useState } from 'react';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import ConsultaIAPanel from './components/ConsultaIAPanel';
import { isConsultationOnlyCeoUser } from './CeoLogin';
import api from './api';
import BackofficeView from './views/BackofficeView';
import BusinessView from './views/BusinessView';
import GroupsView from './views/GroupsView';
import LabelsView from './views/LabelsView';
import MeetingsView from './views/MeetingsView';
import SettingsView from './views/SettingsView';
import SpecialistsView from './views/SpecialistsView';
import TemplatesView from './views/TemplatesView';

const CHART_COLORS = ['#BFBFBF', '#F2F2F2', '#737373', '#4A4A4A', '#2E2E2E'];

const NAV_SECTIONS = [
  { label: 'General', items: [{ key: 'dashboard', label: 'Resumen ejecutivo' }, { key: 'ai', label: 'Consultas IA' }] },
  { label: 'CRM omnicanal', items: [{ key: 'groups', label: 'Grupos' }, { key: 'labels', label: 'Etiquetas' }, { key: 'templates', label: 'Plantillas' }, { key: 'business', label: 'Business' }] },
  { label: 'Agente de reuniones', items: [{ key: 'meetings', label: 'Gestión de reuniones', badge: 'Nuevo' }] },
  { label: 'Administración', items: [{ key: 'specialists', label: 'Especialistas' }, { key: 'backoffice', label: 'Backoffice' }, { key: 'settings', label: 'Configuración' }] },
];

const VIEW_TITLES = {
  dashboard: 'Resumen ejecutivo',
  ai: 'Consultas IA',
  meetings: 'Gestión de reuniones',
  groups: 'Grupos',
  labels: 'Etiquetas',
  business: 'Catálogo Business',
  settings: 'Configuración',
  templates: 'Plantillas',
  specialists: 'Especialistas',
  backoffice: 'Backoffice',
};

function Section({ title, children, className = '' }) {
  return <div className={`rounded-md border border-[#2E2E2E] bg-[#141414] p-4 sm:p-5 ${className}`}>{title && <h3 className="mb-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[#737373]">{title}</h3>}{children}</div>;
}

function formatNumber(value) {
  if (value === undefined || value === null || value === '') return '—';
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? String(value) : new Intl.NumberFormat('es-ES').format(numberValue);
}

function MetricCard({ label, value, subtext, trend }) {
  return (
    <div className="rounded-md border border-[#2E2E2E] bg-[#141414] px-4 py-3.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-[#F2F2F2]">{formatNumber(value)}</p>
      <div className="mt-1.5 flex items-center gap-2"><span className="h-1 w-8 overflow-hidden rounded bg-[#2E2E2E]"><span className="block h-full w-3/4 bg-[#BFBFBF]" /></span><p className="text-[11px] text-[#737373]">{trend || subtext}</p></div>
    </div>
  );
}

function TypeChart({ byType }) {
  const data = (byType || []).map((item, index) => ({ tipo: item.tipo || 'N/A', cantidad: Number(item.cantidad) || 0, color: CHART_COLORS[index % CHART_COLORS.length] }));
  if (!data.length) return <div className="flex h-48 items-center justify-center text-xs text-[#737373]">Sin datos para mostrar</div>;
  return <div className="h-56 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}><XAxis dataKey="tipo" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 10 }} dy={8} /><Tooltip cursor={{ fill: '#0D0D0D' }} contentStyle={{ backgroundColor: '#141414', border: '1px solid #2E2E2E', borderRadius: 4, color: '#F2F2F2', fontSize: 12 }} labelStyle={{ color: '#F2F2F2', fontSize: 11 }} /><Bar dataKey="cantidad" radius={[2, 2, 0, 0]}>{data.map((entry, index) => <Cell key={`${entry.tipo}-${index}`} fill={entry.color} stroke="none" />)}</Bar></BarChart></ResponsiveContainer></div>;
}

function ChatCard({ chat }) {
  const name = chat.nombre || chat.id || 'Sin nombre';
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return <div className="flex min-w-0 items-center gap-3 border-b border-[#2E2E2E] py-3 last:border-b-0"><div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2E2E2E] text-[10px] font-semibold text-[#F2F2F2]">{initials}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-[#F2F2F2]">{name}</p><p className="mt-0.5 truncate text-[11px] text-[#737373]">{chat.ultimo_mensaje || 'Sin mensajes recientes'}</p></div><span className="font-mono text-[10px] text-[#737373]">{chat.updated_at ? new Date(chat.updated_at).toLocaleDateString('es-ES') : '—'}</span></div>;
}

function Sidebar({ view, setView, consultationOnly, onLogout, mobileOpen, onClose }) {
  const sections = consultationOnly ? [{ label: 'General', items: [{ key: 'ai', label: 'Consultas IA' }] }] : NAV_SECTIONS;
  const selectView = (nextView) => { setView(nextView); onClose(); };
  return <>
    {mobileOpen && <button aria-label="Cerrar navegación" type="button" onClick={onClose} className="fixed inset-0 z-30 bg-black/70 lg:hidden" />}
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-[#2E2E2E] bg-[#141414] transition-transform duration-200 lg:static lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex items-center gap-2 border-b border-[#2E2E2E] px-4 py-5"><span className="size-4 rounded-sm bg-[#BFBFBF]" /><div><p className="text-sm font-semibold text-[#F2F2F2]">LYN Superagente</p><p className="mt-0.5 text-[10px] text-[#737373]">Centro de operaciones</p></div></div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {sections.map((section) => <div key={section.label} className="mb-5"><p className="mb-1.5 px-2 font-mono text-[9px] uppercase tracking-[0.15em] text-[#737373]">{section.label}</p>{section.items.map((item) => <button key={item.key} type="button" onClick={() => selectView(item.key)} className={`group flex w-full items-center gap-2 border-l-2 px-2.5 py-2 text-left text-xs transition ${view === item.key ? 'border-l-[#BFBFBF] bg-[#0D0D0D] font-semibold text-[#F2F2F2]' : 'border-l-transparent text-[#BFBFBF] hover:bg-[#0D0D0D] hover:text-[#F2F2F2]'}`}><span className={`size-1.5 rounded-sm ${view === item.key ? 'bg-[#BFBFBF]' : 'bg-[#4A4A4A] group-hover:bg-[#737373]'}`} /><span className="flex-1">{item.label}</span>{item.badge && <span className="rounded border border-[#737373] px-1 py-0.5 font-mono text-[8px] uppercase tracking-wide text-[#BFBFBF]">{item.badge}</span>}</button>)}</div>)}
      </nav>
      <div className="border-t border-[#2E2E2E] p-3"><div className="flex items-center justify-between rounded border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2"><div><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#737373]">Sesión</p><p className="mt-0.5 text-xs text-[#BFBFBF]">Panel protegido</p></div><button type="button" onClick={onLogout} className="text-[11px] text-[#737373] hover:text-[#F2F2F2]">Salir</button></div></div>
    </aside>
  </>;
}

export default function CEOApp({ user, onLogout }) {
  const consultationOnly = isConsultationOnlyCeoUser(user);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef(null);
  const [view, setView] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return consultationOnly ? 'ai' : (params.get('view') || 'dashboard');
  });

  useEffect(() => { if (consultationOnly && view !== 'ai') setView('ai'); }, [consultationOnly, view]);
  useEffect(() => { const url = new URL(window.location.href); if (view === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', view); window.history.replaceState({}, '', url); mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }, [view]);

  const loadMetrics = async () => {
    setLoading(true);
    setError('');
    try { setMetrics((await api.metrics()) || {}); } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  };

  useEffect(() => { if (!consultationOnly && view === 'dashboard') loadMetrics(); }, [consultationOnly, view]);

  const renderView = () => {
    if (consultationOnly) return <div className="p-4 sm:p-6 xl:p-8"><ConsultaIAPanel /></div>;
    switch (view) {
      case 'groups': return <GroupsView />;
      case 'meetings': return <MeetingsView />;
      case 'labels': return <LabelsView />;
      case 'business': return <BusinessView />;
      case 'settings': return <SettingsView />;
      case 'templates': return <TemplatesView />;
      case 'specialists': return <SpecialistsView />;
      case 'backoffice': return <BackofficeView />;
      case 'ai': return <div className="p-4 sm:p-6 xl:p-8"><ConsultaIAPanel /></div>;
      default: return <div className="p-4 sm:p-6 xl:p-8"><div className="mx-auto max-w-[1500px]">{metrics && <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Mensajes" value={metrics.totals?.mensajes} subtext="Total registros" /><MetricCard label="Chats activos" value={metrics.totals?.chats_activos} subtext="Conversaciones únicas" /><MetricCard label="Chats últimas 24 h" value={metrics.totals?.chats_ultimas_24h} subtext="Actividad reciente" /><MetricCard label="Chats última hora" value={metrics.totals?.chats_ultima_1h} subtext="Actividad en vivo" /></div><div className="mt-5 grid gap-4 xl:grid-cols-5"><Section title="Distribución por tipo" className="xl:col-span-2"><TypeChart byType={metrics.byType} /></Section><Section title="Chats destacados" className="xl:col-span-3">{(metrics.topChats || []).slice(0, 8).map((chat) => <ChatCard key={chat.id} chat={chat} />)}{!(metrics.topChats || []).length && <p className="py-8 text-center text-xs text-[#737373]">Sin chats destacados.</p>}</Section></div></>}<div className="mt-5"><ConsultaIAPanel /></div></div></div>;
    }
  };

  return <div className="flex min-h-screen bg-[#0D0D0D] text-[#F2F2F2] selection:bg-[#BFBFBF] selection:text-black"><Sidebar view={view} setView={setView} consultationOnly={consultationOnly} onLogout={onLogout} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} /><main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto"><header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-[#2E2E2E] bg-[#141414]/95 px-4 backdrop-blur sm:px-6 xl:px-8"><div className="flex min-w-0 items-center gap-3"><button type="button" aria-label="Abrir navegación" onClick={() => setMobileOpen(true)} className="rounded border border-[#2E2E2E] p-2 text-[#BFBFBF] hover:border-[#737373] lg:hidden"><svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button><div className="min-w-0"><p className="truncate text-xs text-[#737373]">Dashboard <span className="px-1 text-[#4A4A4A]">/</span> {view === 'meetings' ? 'Agente de reuniones' : consultationOnly ? 'Acceso de consultas' : 'Operaciones'}</p><h1 className="truncate text-sm font-semibold text-[#F2F2F2]">{VIEW_TITLES[view] || 'Dashboard'}</h1></div></div><div className="flex shrink-0 items-center gap-2">{!consultationOnly && view === 'dashboard' && <button type="button" onClick={loadMetrics} disabled={loading} className="hidden rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] hover:border-[#737373] disabled:opacity-40 sm:block">{loading ? 'Actualizando…' : 'Actualizar'}</button>}<span className="hidden rounded border border-[#2E2E2E] px-2.5 py-1.5 text-[10px] text-[#BFBFBF] sm:block">Operación centralizada</span><span title={user?.usuario || 'Usuario'} className="flex size-8 items-center justify-center rounded-full bg-[#2E2E2E] text-[10px] font-semibold text-[#F2F2F2]">{String(user?.usuario || 'LY').slice(0, 2).toUpperCase()}</span></div></header>{!consultationOnly && error && view === 'dashboard' && <div className="mx-4 mt-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200 sm:mx-6 xl:mx-8">{error}</div>}{renderView()}</main></div>;
}