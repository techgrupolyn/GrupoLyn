import { useEffect, useMemo, useState } from 'react';
import api from '../api';

export default function GroupsView() {
  const [chats, setChats] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadChats = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.ceoChats();
      setChats(Array.isArray(data) ? data : []);
    } catch {
      setError('No se pudo cargar el registro central de grupos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadChats(); }, []);

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return chats.filter((chat) => {
      const searchable = `${chat.nombre || ''} ${chat.account_name || ''} ${chat.id || ''}`.toLowerCase();
      return !normalizedQuery || searchable.includes(normalizedQuery);
    });
  }, [chats, query]);

  return (
    <div className="ceo-page p-4 sm:p-6 xl:p-8">
      <h2 className="font-display text-2xl font-medium tracking-wide text-[#F2F2F2]">Grupos</h2>
      <p className="mt-2 max-w-3xl text-xs text-[#737373]">
        Registro global de los grupos sincronizados. Las operaciones de WhatsApp se ejecutan desde la extensión vinculada a cada cuenta para preservar el aislamiento entre empleados.
      </p>

      <div className="mt-8 ceo-card rounded-md border border-[#2E2E2E] bg-[#141414] p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por grupo o cuenta"
            className="h-10 w-full max-w-md ceo-surface rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]"
          />
          <button type="button" onClick={loadChats} disabled={loading} className="ceo-button-primary rounded-md bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {loading ? 'Actualizando...' : 'Actualizar'}
          </button>
        </div>

        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
        {!loading && !error && groups.length === 0 && <p className="mt-6 text-xs text-[#737373]">No hay grupos sincronizados para mostrar.</p>}

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="border-b border-[#2E2E2E] text-[10px] uppercase tracking-widest text-[#737373]">
              <tr><th className="px-3 py-3">Grupo</th><th className="px-3 py-3">Cuenta</th><th className="px-3 py-3">Pendientes</th><th className="px-3 py-3">Última actividad</th></tr>
            </thead>
            <tbody>
              {groups.map((chat) => (
                <tr key={`${chat.account_id || 'unknown'}-${chat.id}`} className="border-b border-[#2E2E2E] text-[#F2F2F2] last:border-b-0">
                  <td className="px-3 py-3">{chat.nombre || chat.id}</td>
                  <td className="px-3 py-3 text-[#BFBFBF]">{chat.account_name || chat.account_id || 'Sin cuenta'}</td>
                  <td className="px-3 py-3">{Number(chat.no_leidos || chat.unread_count || 0)}</td>
                  <td className="px-3 py-3 text-[#737373]">{chat.ultimo_mensaje_at ? new Date(chat.ultimo_mensaje_at).toLocaleString() : 'Sin actividad'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}