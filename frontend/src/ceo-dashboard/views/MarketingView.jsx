import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import { montarPanel } from '../marketing/panelEngine';

// Panel de marketing (épico 869fny1et): gasto, calidad, coste por fase, conversión y nota comercial.
// React carga los datos; el panel (árbol de filtros y gráficos) lo dibuja panelEngine.js.
export default function MarketingView() {
  const host = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError('');
    api.marketing.panel()
      .then((payload) => { if (active) setData(payload); })
      .catch((requestError) => { if (active) setError(requestError.body || requestError.message); });
    return () => { active = false; };
  }, [reload]);

  const recargar = useCallback(async () => {
    try {
      const { resultados = [] } = await api.marketing.load() || {};
      const fallos = resultados.filter((r) => r.estado === 'error');
      if (fallos.length) setError(fallos.map((r) => `${r.fuente}: ${r.detalle}`).join(' · '));
    } catch (requestError) {
      setError(requestError.body || requestError.message);
    }
    setReload((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!data || !host.current) return undefined;
    const panel = montarPanel(host.current, data, { onGuardarPonderaciones: api.marketing.saveWeights, onRecargar: recargar });
    return () => panel.destroy();
  }, [data, recargar]);

  return <section className="ceo-page">
    {error && <p role="alert" className="mx-4 mt-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200 sm:mx-6">{error}</p>}
    {!data && !error && <p role="status" className="p-6 text-sm text-[#BFBFBF]">Cargando panel de marketing…</p>}
    <div ref={host} />
  </section>;
}
