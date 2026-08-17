import { useEffect, useState } from 'react';
import api from '../api';

export default function BusinessView() {
  const [number, setNumber] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [collections, setCollections] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadCatalog = async () => {
    if (!number) return;
    setLoading(true);
    try {
      const data = await api.business.catalog(number);
      setCatalog(data || null);
    } catch { setCatalog(null); } finally { setLoading(false); }
  };

  const loadCollections = async () => {
    if (!number) return;
    setLoading(true);
    try {
      const data = await api.business.collections(number);
      setCollections(data || null);
    } catch { setCollections(null); } finally { setLoading(false); }
  };

  return (
    <div className="p-10">
      <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Catálogo Business</h2>
      <p className="mt-2 text-xs text-[#737373]">Consultá productos y colecciones de cuentas business verificadas.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Catálogo</p>
          <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} placeholder="Número" className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <button type="button" onClick={loadCatalog} disabled={loading} className="mt-3 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">Consultar catálogo</button>
          <pre className="mt-4 max-h-64 overflow-y-auto rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-[10px] text-[#737373]">{JSON.stringify(catalog, null, 2)}</pre>
        </div>

        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Colecciones</p>
          <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} placeholder="Número" className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <button type="button" onClick={loadCollections} disabled={loading} className="mt-3 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">Consultar colecciones</button>
          <pre className="mt-4 max-h-64 overflow-y-auto rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-[10px] text-[#737373]">{JSON.stringify(collections, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
