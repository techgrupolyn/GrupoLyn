import { useEffect, useState } from 'react';
import api from '../api';

export default function LabelsView() {
  const [labels, setLabels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ nombre: '', color: '#6366f1' });
  const [handleForm, setHandleForm] = useState({ chatId: '', label: '', action: 'add' });

  const loadLabels = async () => {
    try {
      const data = await api.labels.list();
      setLabels(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadLabels(); }, []);

  const createLabel = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.labels.handle({ name: form.nombre });
      setForm({ nombre: '', color: '#6366f1' });
      await loadLabels();
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const handleLabel = async (e) => {
    e.preventDefault();
    if (!handleForm.chatId || !handleForm.label) return;
    setLoading(true);
    try {
      await api.labels.handle({ chatId: handleForm.chatId, name: handleForm.label, action: handleForm.action });
      setHandleForm({ chatId: '', label: '', action: 'add' });
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  return (
    <div className="ceo-page p-4 sm:p-6 xl:p-8">
      <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Etiquetas</h2>
      <p className="mt-2 text-xs text-[#737373]">Creá etiquetas y asignalas a chats.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form onSubmit={createLabel} className="ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Crear etiqueta</p>
          <input value={form.nombre} onChange={(e) => setForm((s) => ({ ...s, nombre: e.target.value }))} placeholder="Nombre" className="mt-4 h-10 w-full ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <input type="color" value={form.color} onChange={(e) => setForm((s) => ({ ...s, color: e.target.value }))} className="mt-3 h-10 w-full ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-2 text-xs text-[#F2F2F2] outline-none" />
          <button type="submit" disabled={loading} className="mt-4 rounded-md bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {loading ? 'Guardando...' : 'Guardar etiqueta'}
          </button>
        </form>

        <form onSubmit={handleLabel} className="ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Asignar/quitar etiqueta</p>
          <input value={handleForm.chatId} onChange={(e) => setHandleForm((s) => ({ ...s, chatId: e.target.value }))} placeholder="chatId" className="mt-4 h-10 w-full ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <input value={handleForm.label} onChange={(e) => setHandleForm((s) => ({ ...s, label: e.target.value }))} placeholder="Etiqueta" className="mt-3 h-10 w-full ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <select value={handleForm.action} onChange={(e) => setHandleForm((s) => ({ ...s, action: e.target.value }))} className="mt-3 h-10 w-full ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none">
            <option value="add">Agregar</option>
            <option value="remove">Quitar</option>
          </select>
          <button type="submit" disabled={loading} className="mt-4 rounded-md bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">Aplicar</button>
        </form>
      </div>

      <div className="mt-8 ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Etiquetas existentes</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {labels.length === 0 && <p className="text-xs text-[#737373]">Sin etiquetas</p>}
          {labels.map((l) => (
            <span key={l.id} className="inline-flex items-center gap-2 rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-1 text-xs text-[#F2F2F2]">
              <span className="size-2 rounded-full" style={{ backgroundColor: l.color || '#6366f1' }} />
              {l.nombre} <span className="text-[#737373]">{l.id}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
