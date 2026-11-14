import { useEffect, useState } from 'react';
import api from '../api';
import { formatMadridDateTime } from '../netelipFormat';

// Calificador interno de llamadas (ticket 869e9y98n): objeciones e ideas de marketing, y comerciales evaluados.
const OBJECTION_LABEL = { precio: 'Precio', plazo: 'Plazo', confianza: 'Confianza', decisor: 'Decisor', otra: 'Otra' };
const ROLE_LABEL = { sdr: 'SDR', closer_f2: 'Closer Fase 2', closer_f3: 'Closer Fase 3' };
const selectClass = 'h-8 rounded border border-[#2E2E2E] bg-[#141414] px-2 text-xs text-[#BFBFBF] outline-none hover:border-amber-300/50';
const inputClass = 'h-8 rounded border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none focus:border-amber-300/60';

export function ObjectionsPanel({ onOpenCall }) {
  const [filters, setFilters] = useState({ tipo: '', from: '', to: '', ideas: '' });
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const query = { ...filters, to: filters.to ? new Date(new Date(filters.to).getTime() + 86_400_000).toISOString().slice(0, 10) : '' };
    api.netelip.objections(query).then((data) => { if (active) { setItems(data.items || []); setError(''); } }).catch((requestError) => { if (active) setError(requestError.body || requestError.message); });
    return () => { active = false; };
  }, [JSON.stringify(filters)]);
  const update = (changes) => setFilters((current) => ({ ...current, ...changes }));
  return <div className="rounded-md border border-[#2E2E2E] bg-[#141414]">
    <div className="flex flex-wrap items-center gap-2 border-b border-[#2E2E2E] px-3 py-3">
      <select aria-label="Filtrar por tipo de objeción" value={filters.tipo} onChange={(event) => update({ tipo: event.target.value })} className={selectClass}><option value="">Tipo</option>{Object.entries(OBJECTION_LABEL).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
      <label className="text-[10px] text-[#737373]">Desde<input type="date" value={filters.from} onChange={(event) => update({ from: event.target.value })} className={`ml-2 ${inputClass}`} /></label>
      <label className="text-[10px] text-[#737373]">Hasta<input type="date" value={filters.to} onChange={(event) => update({ to: event.target.value })} className={`ml-2 ${inputClass}`} /></label>
      <label className="flex items-center gap-1.5 text-xs text-[#BFBFBF]"><input type="checkbox" checked={filters.ideas === '1'} onChange={(event) => update({ ideas: event.target.checked ? '1' : '' })} />Solo con idea de contenido</label>
      <p className="ml-auto text-[10px] text-[#737373]">Sin datos personales: las citas salen de la transcripción enmascarada.</p>
    </div>
    {error && <p role="alert" className="m-3 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left"><thead className="bg-[#0D0D0D] font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]"><tr><th className="px-3 py-3">Fecha</th><th className="px-3 py-3">Tipo</th><th className="px-3 py-3">Lo que dijo el cliente</th><th className="px-3 py-3">Idea de contenido</th></tr></thead>
      <tbody className="divide-y divide-[#2E2E2E]">
        {(items || []).map((item) => <tr key={item.id} onClick={() => onOpenCall(item.llamada_id)} className="cursor-pointer hover:bg-[#0D0D0D]">
          <td className="px-3 py-3 font-mono text-xs text-[#F2F2F2]">{formatMadridDateTime(item.occurred_at)}</td>
          <td className="px-3 py-3 text-xs text-[#BFBFBF]">{OBJECTION_LABEL[item.tipo] || item.tipo}</td>
          <td className="px-3 py-3 text-xs leading-5 text-[#D4D4D4]">«{item.cita}»</td>
          <td className="px-3 py-3 text-xs leading-5 text-amber-100">{item.idea_contenido || <span className="text-[#4A4A4A]">—</span>}</td>
        </tr>)}
        {items === null && !error && <tr><td colSpan="4" className="px-3 py-12 text-center text-xs text-[#737373]" role="status">Cargando objeciones…</td></tr>}
        {items?.length === 0 && <tr><td colSpan="4" className="px-3 py-12 text-center text-xs text-[#737373]">Todavía no hay objeciones registradas con estos filtros. Aparecerán al evaluar las llamadas de los comerciales.</td></tr>}
      </tbody></table></div>
  </div>;
}

const EMPTY = { extension: '', nombre: '', rol: 'sdr', whatsapp: '', activo: true };

export function SalespeoplePanel() {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const load = () => api.netelip.salespeople().then((data) => { setItems(data.items || []); setError(''); }).catch((requestError) => setError(requestError.body || requestError.message));
  useEffect(() => { void load(); }, []);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      await api.netelip.saveSalesperson(form.extension.trim(), { nombre: form.nombre, rol: form.rol, whatsapp: form.whatsapp || null, activo: form.activo });
      setForm(EMPTY);
      await load();
    } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo guardar.'); }
    finally { setSaving(false); }
  };
  const edit = (item) => setForm({ extension: item.extension_netelip, nombre: item.nombre, rol: item.rol, whatsapp: item.whatsapp || '', activo: item.activo });
  const field = (key) => ({ value: form[key], onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })) });
  return <div className="rounded-md border border-[#2E2E2E] bg-[#141414] p-4">
    <p className="text-xs leading-5 text-[#BFBFBF]">Solo se evalúan las llamadas de las extensiones dadas de alta aquí y activas, de 60 segundos o más. El feedback llega al WhatsApp indicado. El comercial debe estar informado por escrito antes de activarlo.</p>
    <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-2">
      <label className="text-[10px] text-[#737373]">Extensión<input required pattern="\d{1,6}" {...field('extension')} className={`mt-1 block w-24 ${inputClass}`} /></label>
      <label className="text-[10px] text-[#737373]">Nombre<input required maxLength={120} {...field('nombre')} className={`mt-1 block w-48 ${inputClass}`} /></label>
      <label className="text-[10px] text-[#737373]">Rol<select {...field('rol')} className={`mt-1 block ${selectClass}`}>{Object.entries(ROLE_LABEL).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
      <label className="text-[10px] text-[#737373]">WhatsApp<input {...field('whatsapp')} placeholder="+34 6…" className={`mt-1 block w-40 ${inputClass}`} /></label>
      <label className="flex h-8 items-center gap-1.5 text-xs text-[#BFBFBF]"><input type="checkbox" checked={form.activo} onChange={(event) => setForm((current) => ({ ...current, activo: event.target.checked }))} />Activo</label>
      <button type="submit" disabled={saving} className="h-8 rounded border border-amber-300/50 px-3 text-xs text-amber-200 hover:bg-amber-300/10 disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar'}</button>
    </form>
    {error && <p role="alert" className="mt-3 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    <table className="mt-4 w-full text-left"><thead className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]"><tr><th className="py-2">Ext.</th><th className="py-2">Nombre</th><th className="py-2">Rol</th><th className="py-2">WhatsApp</th><th className="py-2">Estado</th><th /></tr></thead>
      <tbody className="divide-y divide-[#2E2E2E]">
        {(items || []).map((item) => <tr key={item.extension_netelip} className="text-xs text-[#D4D4D4]"><td className="py-2 font-mono">{item.extension_netelip}</td><td className="py-2">{item.nombre}</td><td className="py-2">{ROLE_LABEL[item.rol] || item.rol}</td><td className="py-2 font-mono">{item.whatsapp || '—'}</td><td className="py-2">{item.activo ? <span className="text-emerald-200">Se evalúa</span> : <span className="text-[#737373]">Pausado</span>}</td><td className="py-2 text-right"><button type="button" onClick={() => edit(item)} className="text-[11px] text-amber-300 hover:text-amber-200">Editar</button></td></tr>)}
        {items?.length === 0 && <tr><td colSpan="6" className="py-6 text-center text-xs text-[#737373]">Aún no hay comerciales configurados.</td></tr>}
      </tbody></table>
  </div>;
}
