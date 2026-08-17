import { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import ConsultaIAPanel from './components/ConsultaIAPanel';
import api from './api';
import BackofficeView from './views/BackofficeView';
import BusinessView from './views/BusinessView';
import GroupsView from './views/GroupsView';
import LabelsView from './views/LabelsView';
import SettingsView from './views/SettingsView';
import SpecialistsView from './views/SpecialistsView';
import TemplatesView from './views/TemplatesView';


const CHART_COLORS = ['#BFBFBF', '#F2F2F2', '#737373', '#2E2E2E', '#141414'];

function Section({ title, children, className }) {
  return (
    <div className={`rounded-lg border border-[#2E2E2E] bg-[#141414] p-5 ${className || ''}`}>
      {title && <h3 className="text-xs font-semibold uppercase tracking-widest text-[#737373] mb-4">{title}</h3>}
      {children}
    </div>
  );
}

function formatNumber(value) {
  if (value === undefined || value === null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return new Intl.NumberFormat('es-ES').format(n);
}

function MetricCard({ label, value, subtext, icon }) {
  return (
    <div className="group relative overflow-hidden rounded-sm border border-[#2E2E2E] bg-[#141414] transition-all duration-300 hover:border-[#F2F2F2]/20 hover:shadow-[0_0_20px_rgba(242,242,242,0.03)]">
      <div className="relative z-10 p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">{label}</p>
            <p className="mt-4 text-4xl font-light text-[#F2F2F2] tracking-wide">{formatNumber(value)}</p>
            {subtext && <p className="mt-2 text-xs text-[#737373]">{subtext}</p>}
          </div>
          <div className="opacity-50 transition-opacity duration-300 group-hover:opacity-100">{icon}</div>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#BFBFBF]/30 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
    </div>
  );
}

function TypeChart({ byType }) {
  const data = (byType || []).map((item, index) => ({
    tipo: item.tipo || 'N/A',
    cantidad: Number(item.cantidad) || 0,
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));

  if (!data.length) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[#737373]">Sin datos para mostrar</div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <XAxis dataKey="tipo" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 10 }} dy={8} />
          <Tooltip
            cursor={{ fill: '#141414', stroke: '#2E2E2E' }}
            contentStyle={{ backgroundColor: '#141414', border: '1px solid #2E2E2E', borderRadius: 0, color: '#F2F2F2', fontSize: 12 }}
            labelStyle={{ color: '#F2F2F2', fontSize: 11 }}
          />
          <Bar dataKey="cantidad" radius={[0, 0, 0, 0]}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.color} stroke="none" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChatCard({ chat }) {
  const nombre = chat.nombre || chat.id || 'Sin nombre';
  const initials = nombre.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="group flex items-center gap-4 rounded-sm border border-[#2E2E2E] bg-[#141414] p-5 transition-all duration-200 hover:border-[#F2F2F2]/20">
      <div className="flex size-12 shrink-0 items-center justify-center bg-[#0D0D0D] font-display text-sm font-medium text-[#F2F2F2]">{initials}</div>
       <div className="min-w-0 flex-1">
         <p className="truncate text-sm font-medium text-[#F2F2F2]">{nombre}</p>
         <p className="mt-1 truncate text-xs text-[#737373]">{chat.ultimo_mensaje || 'Sin mensajes recientes'}</p>
       </div>
      <div className="hidden shrink-0 flex-col items-end sm:flex">
        <span className="text-[10px] font-medium uppercase tracking-widest text-[#737373]">{chat.updated_at ? new Date(chat.updated_at).toLocaleDateString('es-ES') : '—'}</span>
        <div className="mt-1.5 size-1 rounded-full bg-[#BFBFBF] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Resumen ejecutivo', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> },
  { key: 'ai', label: 'Consultas IA', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M6 21v-2a8 8 0 0 1 12 0v2"/><path d="M6 21h12"/></svg> },
  { key: 'groups', label: 'Grupos', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
  { key: 'labels', label: 'Etiquetas', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
  { key: 'business', label: 'Business', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { key: 'settings', label: 'Configuración', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> },
  { key: 'templates', label: 'Plantillas', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg> },
  { key: 'specialists', label: 'Especialistas', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg> },
  { key: 'backoffice', label: 'Backoffice', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg> },
];

export default function CEOApp() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [view, setView] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') || 'dashboard';
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === 'dashboard') {
      url.searchParams.delete('view');
    } else {
      url.searchParams.set('view', view);
    }
    window.history.replaceState({}, '', url);
  }, [view]);

  const loadMetrics = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.metrics();
      setMetrics(data || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (view === 'dashboard') loadMetrics();
  }, [view]);

  const MessageIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
  const ChatIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
  const ClockIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
  const TrendingIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
  const ServerIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );

  const viewTitles = {
    dashboard: 'Resumen ejecutivo',
    ai: 'Consultas IA',
    groups: 'Grupos',
    labels: 'Etiquetas',
    business: 'Catálogo Business',
    settings: 'Configuración',
    templates: 'Plantillas',
    backoffice: 'Backoffice',
  };

  const renderView = () => {
    switch (view) {
      case 'groups': return <GroupsView />;
      case 'labels': return <LabelsView />;
      case 'business': return <BusinessView />;
      case 'settings': return <SettingsView />;
      case 'templates': return <TemplatesView />;
      case 'specialists': return <SpecialistsView />;
      case 'backoffice': return <BackofficeView />;
      default: return (
        <>
          {metrics && (
            <section className="p-10">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Mensajes" value={metrics.totals?.mensajes} subtext="Total registros" icon={<MessageIcon />} />
                <MetricCard label="Chats activos" value={metrics.totals?.chats_activos} subtext="Conversaciones únicas" icon={<ChatIcon />} />
                <MetricCard label="Chats últimas 24h" value={metrics.totals?.chats_ultimas_24h} subtext="Actividad reciente" icon={<ClockIcon />} />
                <MetricCard label="Chats última 1h" value={metrics.totals?.chats_ultima_1h} subtext="Actividad en vivo" icon={<TrendingIcon />} />
              </div>
              <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-5">
                <Section title="Distribución por tipo" className="lg:col-span-2"><TypeChart byType={metrics.byType} /></Section>
                <Section title="Chats destacados" className="lg:col-span-3">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {(metrics.topChats || []).slice(0, 12).map((chat) => <ChatCard key={chat.id} chat={chat} />)}
                  </div>
                </Section>
              </div>
            </section>
          )}
          <ConsultaIAPanel />
        </>
      );
    }
  };

  return (
    <div className="flex h-screen bg-[#0D0D0D] text-[#F2F2F2] selection:bg-[#BFBFBF] selection:text-black">
      <aside className="flex w-72 flex-col border-r border-[#2E2E2E] bg-[#141414]">
        <div className="border-b border-[#2E2E2E] px-6 py-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-[#737373]">LYN</p>
          <h1 className="mt-4 font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Dashboard CEO</h1>
          <div className="mt-4 h-px w-12 bg-[#BFBFBF]/60" />
          <p className="mt-4 text-xs text-[#737373] leading-relaxed">Panel ejecutivo para monitoreo de operaciones y métricas.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.4em] text-[#737373]">Navegación</p>
          <nav className="mt-6 space-y-1.5">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => { setView(item.key); document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' }); }}
                className={`flex w-full items-center gap-3 rounded-sm px-4 py-3 text-left text-xs font-medium transition-all duration-200 ${
                  view === item.key ? 'border border-[#2E2E2E] bg-[#0D0D0D] text-[#F2F2F2]' : 'text-[#737373] hover:bg-[#0D0D0D]/70 hover:text-[#F2F2F2]'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="border-t border-[#2E2E2E] px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest text-[#737373]">Backend</p>
              <p className="mt-1 text-[10px] text-[#737373]">/api</p>
            </div>
            <div className="opacity-70"><ServerIcon /></div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <header className="flex items-center justify-between border-b border-[#2E2E2E] bg-[#141414] px-10 py-8">
          <div>
            <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">{viewTitles[view] || 'Dashboard'}</h2>
            <p className="mt-2 text-xs text-[#737373]">
              Actualizado: {currentTime.toLocaleString('es-ES')} — Indicadores clave derivados de la base de datos.
            </p>
          </div>
          {view === 'dashboard' && (
            <>
              <button
                type="button"
                onClick={loadMetrics}
                disabled={loading}
                className="rounded-sm bg-[#BFBFBF] px-6 py-3 text-xs font-semibold uppercase tracking-widest text-black transition-all duration-200 hover:bg-[#d4d4d4] disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]"
              >
                {loading ? (
                  <span className="flex items-center gap-2.5">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
                    Actualizando…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Refrescar
                  </span>
                )}
              </button>
            </>
          )}
        </header>



        {error && view === 'dashboard' && (
          <div className="mx-10 mt-10 rounded-sm border border-[#2E2E2E] bg-[#141414] p-5 text-xs text-[#737373]">{error}</div>
        )}

        {renderView()}


      </main>
    </div>
  );
}
