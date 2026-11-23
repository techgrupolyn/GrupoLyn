import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import { formatMadridDateTime, formatPhone } from '../netelipFormat';

// N-1.0 · Llamadas cuyo teléfono coincide con VARIAS tarjetas de «Contacto de Reforma»: no se asocian solas. Aquí se elige a mano la
// tarjeta correcta. Solo se muestra si hay alguna. Asignar no escribe nada en ClickUp.
export default function LlamadasSinAsignarPanel() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.captacionLlamadas.sinAsignar());
      setLoadFailed(false);
    } catch {
      // No se esconde: si la lista no carga, las llamadas pendientes quedarían invisibles para quien debe asignarlas. La tabla de llamadas sigue funcionando.
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  if (loadFailed && !items.length) {
    return <p role="alert" aria-label="Llamadas con varias coincidencias" className="mb-4 flex flex-wrap items-center gap-3 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">No se pudo cargar la lista de llamadas con varias coincidencias.<button type="button" onClick={load} className="rounded border border-red-900/70 px-2 py-1 text-[11px] hover:border-red-300/60">Reintentar</button></p>;
  }
  if (!items.length) return null;
  // La lista trae como mucho 500; el total real sale del resumen (al asignar, las demás van entrando).
  const total = Math.max(items.length, Number(data?.resumen?.varias_coincidencias) || 0);

  const asignar = async (llamadaId, tarea) => {
    setBusy(`${llamadaId}:${tarea}`);
    setError('');
    try {
      await api.captacionLlamadas.asignar(llamadaId, tarea);
      await load();
    } catch (requestError) {
      setError(requestError.body || requestError.message || 'No se pudo asignar la llamada.');
    } finally {
      setBusy('');
    }
  };

  return <section aria-label="Llamadas con varias coincidencias" className="mb-4 rounded-md border border-amber-300/30 bg-amber-300/[.05] p-3">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 text-left text-xs text-amber-100">
      <span>{total === 1 ? '1 llamada tiene su teléfono en varias tarjetas de ClickUp y no se asoció sola.' : `${total} llamadas tienen su teléfono en varias tarjetas de ClickUp y no se asociaron solas.`}</span>
      <span className="shrink-0 text-amber-300">{open ? 'Ocultar' : 'Elegir a mano'}</span>
    </button>
    {open && <div className="mt-3 space-y-2">
      {error && <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-2 text-xs text-red-200">{error}</p>}
      {items.map((item) => <div key={item.llamada_id} className="rounded border border-[#2E2E2E] bg-[#141414] p-3">
        <p className="text-xs text-[#F2F2F2]">{formatPhone(item.phone)} <span className="text-[#737373]">· {formatMadridDateTime(item.occurred_at)}</span></p>
        <ul className="mt-2 space-y-1.5">
          {item.candidatos.map((candidato) => <li key={candidato.id} className="flex flex-wrap items-center gap-2 text-xs text-[#D4D4D4]">
            <span className="min-w-0 truncate">{candidato.nombre || candidato.id}</span>
            {candidato.url && <a href={candidato.url} target="_blank" rel="noreferrer" className="text-[11px] text-amber-300 hover:text-amber-200">Ver tarjeta</a>}
            <button type="button" disabled={Boolean(busy)} onClick={() => asignar(item.llamada_id, candidato.id)} aria-label={`Asignar la llamada de ${formatPhone(item.phone)} a ${candidato.nombre || candidato.id}`} className="ml-auto rounded border border-[#2E2E2E] px-2 py-1 text-[11px] text-[#BFBFBF] hover:border-amber-300/50 disabled:opacity-50">{busy === `${item.llamada_id}:${candidato.id}` ? 'Asignando…' : 'Asignar a esta'}</button>
          </li>)}
        </ul>
      </div>)}
    </div>}
  </section>;
}
