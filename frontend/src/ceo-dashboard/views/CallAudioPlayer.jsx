// Reproducir el audio de una llamada grabada desde la ventana de la transcripción (1an2gnpzyp7).
// El audio se pide con la sesión del Dashboard y se reproduce desde una URL blob: que solo existe en
// esta pestaña: no hay enlace público ni reutilizable. Al cerrar la ventana o abrir otra llamada, el
// componente se desmonta, el audio se detiene y la URL se libera.
import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import api from '../api';

const UNAVAILABLE = 'Grabación no disponible';

/** Motivo por el que no se puede escuchar, o null si se puede. */
export function audioUnavailableReason(call, transcriptionAccess) {
  if (transcriptionAccess === 'denied') return 'No tienes permiso para escuchar las llamadas';
  if (!call?.recorded || call.via !== 'phone') return UNAVAILABLE;
  return null;
}

export default function CallAudioPlayer({ call, transcriptionAccess }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const audioRef = useRef(null);

  // El elemento se guarda al montarlo: al desmontar, React ya ha soltado la ref, y un <audio> fuera del DOM
  // sigue sonando si no se pausa.
  useEffect(() => {
    if (!url) return undefined;
    const element = audioRef.current;
    return () => {
      element?.pause();
      URL.revokeObjectURL(url);
    };
  }, [url]);

  const reason = audioUnavailableReason(call, transcriptionAccess);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const blob = await api.netelip.audio(call.id);
      setUrl(URL.createObjectURL(blob));
    } catch (requestError) {
      setError(requestError.status === 404 || requestError.status === 503 ? `${UNAVAILABLE}.` : 'No se pudo cargar la grabación. Vuelve a intentarlo.');
    } finally {
      setLoading(false);
    }
  };

  if (url) {
    return <audio ref={audioRef} src={url} controls autoPlay preload="auto" aria-label="Audio de la llamada" className="w-full" />;
  }
  return <div className="flex flex-wrap items-center gap-3">
    <button type="button" onClick={load} disabled={Boolean(reason) || loading} aria-label="Reproducir audio"
      className="inline-flex items-center gap-2 rounded border border-amber-300/40 bg-amber-300/[.08] px-3 py-1.5 text-xs text-amber-100 hover:border-amber-300/70 disabled:cursor-not-allowed disabled:border-[#2E2E2E] disabled:bg-[#141414] disabled:text-[#737373]">
      <Play size={13} aria-hidden="true" />{loading ? 'Cargando audio…' : 'Reproducir audio'}
    </button>
    {reason && <span className="text-[11px] text-[#737373]">{reason}</span>}
    {error && <span role="alert" className="text-[11px] text-red-200">{error}</span>}
  </div>;
}
