import { useEffect, useState } from 'react';
import api from '../api';

export default function SpecialistsView() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.specialists.list().then((data) => {
      if (!cancelled) setItems(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const updateField = (id, field, value) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const save = async (item) => {
    setSavingId(item.id);
    setError('');
    try {
      const payload = {
        nombre: item.nombre,
        rol: item.rol,
        sistema_prompt: item.sistema_prompt,
        modelo: item.modelo,
        activo: item.activo,
      };
      await api.specialists.update(item.id, payload);
      setSavingId(null);
    } catch (err) {
      setError(err?.message || 'Error guardando especialista');
      setSavingId(null);
    }
  };

  return (
    <section className="p-10">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Especialistas</h2>
          <p className="mt-2 text-xs text-[#737373]">Actualizá el contexto y el prompt de cada especialista. Se guarda en la base de datos y se aplica en tiempo real.</p>
        </div>
      </div>

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

      <div className="mt-8 grid grid-cols-1 gap-5">
        {loading && <p className="text-xs text-[#737373]">Cargando especialistas...</p>}
        {!loading && items.length === 0 && <p className="text-xs text-[#737373]">Sin especialistas</p>}
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-[#2E2E2E] bg-[#141414] p-5">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-3">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-[#737373]">Nombre</label>
                <input
                  className="mt-2 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2 text-xs text-[#F2F2F2]"
                  value={item.nombre || ''}
                  onChange={(e) => updateField(item.id, 'nombre', e.target.value)}
                />
              </div>
              <div className="lg:col-span-2">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-[#737373]">Rol</label>
                <input
                  className="mt-2 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2 text-xs text-[#F2F2F2]"
                  value={item.rol || ''}
                  onChange={(e) => updateField(item.id, 'rol', e.target.value)}
                />
              </div>
              <div className="lg:col-span-2">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-[#737373]">Modelo</label>
                <select
                  className="mt-2 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2 text-xs text-[#F2F2F2]"
                  value={item.modelo || 'flash'}
                  onChange={(e) => updateField(item.id, 'modelo', e.target.value)}
                >
                  <option value="flash">Flash</option>
                  <option value="pro">Pro</option>
                </select>
              </div>
              <div className="lg:col-span-2 flex items-center gap-2">
                <input
                  id={`active-${item.id}`}
                  type="checkbox"
                  checked={item.activo !== false}
                  onChange={(e) => updateField(item.id, 'activo', e.target.checked)}
                />
                <label htmlFor={`active-${item.id}`} className="text-xs text-[#F2F2F2]">Activo</label>
              </div>
              <div className="lg:col-span-3 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => save(item)}
                  disabled={savingId === item.id}
                  className="rounded-sm bg-[#00A884] px-4 py-2 text-xs font-semibold text-black hover:bg-[#008f6f] disabled:opacity-60"
                >
                  {savingId === item.id ? 'Guardando...' : 'Guardar cambios'}
                </button>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-[#737373]">Contexto / Prompt</label>
              <textarea
                className="mt-2 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 py-2 text-xs text-[#F2F2F2]"
                rows={4}
                value={item.sistema_prompt || ''}
                onChange={(e) => updateField(item.id, 'sistema_prompt', e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
