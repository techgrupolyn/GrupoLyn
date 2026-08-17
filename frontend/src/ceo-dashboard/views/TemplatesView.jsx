import { useEffect, useState } from 'react';
import api from '../api';

export default function TemplatesView() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ id: null, name: '', language: 'es', components: '', tipo: 'template' });
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.templates.list();
      setItems(Array.isArray(data) ? data : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError('');
    try {
      let components = form.components;
      if (typeof components === 'string') {
        try { components = JSON.parse(components); } catch { /* keep string */ }
      }
      if (form.id) {
        await api.templates.update(form.id, form.name.trim(), form.language.trim(), components);
      } else {
        await api.templates.create(form.name.trim(), form.language.trim(), components, form.tipo);
      }
      await load();
      setForm({ id: null, name: '', language: 'es', components: '', tipo: 'template' });
    } catch (err) {
      setError(String(err?.message || 'Error guardando plantilla'));
    } finally { setSaving(false); }
  };

  const edit = (item) => {
    const components = typeof item.componentes === 'string' ? item.componentes : JSON.stringify(item.componentes || {}, null, 2);
    setForm({ id: item.id, name: item.nombre, language: item.lenguaje || 'es', components, tipo: item.tipo || 'template' });
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar plantilla?')) return;
    setSaving(true);
    try {
      await api.templates.delete(id);
      await load();
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  return (
    <div className="p-10">
      <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Plantillas</h2>
      <p className="mt-2 text-xs text-[#737373]">CRUD de plantillas de mensaje sincronizadas con Evolution API.</p>

      <form onSubmit={save} className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-4">
        <label className="text-xs text-[#737373]">
          Nombre
          <input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} className="mt-2 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" required />
        </label>
        <label className="text-xs text-[#737373]">
          Lenguaje
          <input value={form.language} onChange={(e) => setForm((s) => ({ ...s, language: e.target.value }))} className="mt-2 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
        </label>
        <label className="text-xs text-[#737373] lg:col-span-1">
          Tipo
          <select value={form.tipo} onChange={(e) => setForm((s) => ({ ...s, tipo: e.target.value }))} className="mt-2 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none">
            <option value="template">Template</option>
            <option value="button">Button</option>
            <option value="list">List</option>
          </select>
        </label>
        <label className="text-xs text-[#737373] lg:col-span-4">
          Componentes (JSON)
          <textarea value={form.components} onChange={(e) => setForm((s) => ({ ...s, components: e.target.value }))} rows={3} className="mt-2 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-xs text-[#F2F2F2] outline-none font-mono" />
        </label>
        <div className="flex items-center gap-3 lg:col-span-4">
          <button type="submit" disabled={saving} className="rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? 'Guardando...' : form.id ? 'Actualizar' : 'Crear'}
          </button>
          {form.id && (
            <button type="button" onClick={() => setForm({ id: null, name: '', language: 'es', components: '', tipo: 'template' })} className="rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-4 py-2 text-xs font-medium text-[#F2F2F2]">
              Cancelar
            </button>
          )}
          {error && <span className="text-xs text-[#EF4444]">{error}</span>}
        </div>
      </form>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-left text-xs text-[#F2F2F2]">
          <thead>
            <tr className="border-b border-[#2E2E2E] text-[10px] uppercase tracking-widest text-[#737373]">
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Lenguaje</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2E2E2E]">
            {loading && (
              <tr><td colSpan={4} className="px-4 py-6 text-xs text-[#737373]">Cargando...</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-xs text-[#737373]">Sin plantillas</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-[#0D0D0D]/60">
                <td className="px-4 py-3">{item.nombre}</td>
                <td className="px-4 py-3">{item.lenguaje || 'es'}</td>
                <td className="px-4 py-3">{item.tipo || 'template'}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => edit(item)} className="rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-2 py-1 text-[10px] uppercase tracking-widest text-[#F2F2F2] hover:bg-[#141414]">Editar</button>
                    <button type="button" onClick={() => remove(item.id)} disabled={saving} className="rounded-sm border border-[#EF4444] bg-[#0D0D0D] px-2 py-1 text-[10px] uppercase tracking-widest text-[#EF4444] hover:bg-[#141414] disabled:cursor-not-allowed disabled:opacity-40">Eliminar</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
