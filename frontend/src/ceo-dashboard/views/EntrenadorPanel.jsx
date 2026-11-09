import { useEffect, useState } from 'react';
import api from '../api';
import { formatMadridDateTime } from '../netelipFormat';

// Documento del entrenador de llamadas (ticket 869e9y98n): el «Contexto unificado» que los comerciales cargan
// en ChatGPT para simular llamadas, mejorado con lo que el calificador saca de las llamadas reales.
const box = 'rounded-md border border-[#2E2E2E] bg-[#141414] p-4';
const label = 'font-mono text-[10px] uppercase tracking-[.12em] text-[#737373]';
const buttonClass = 'rounded border border-[#2E2E2E] px-3 py-1.5 text-xs text-[#BFBFBF] hover:border-amber-300/50 disabled:cursor-not-allowed disabled:opacity-40';
const madridDate = (value) => (value ? new Date(value).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' }) : '');
const POLL_MS = 5000;

function periodo(version) {
  if (!version.periodo_hasta) return 'Documento original';
  return version.periodo_desde ? `${madridDate(version.periodo_desde)} → ${madridDate(version.periodo_hasta)}` : `Hasta ${madridDate(version.periodo_hasta)}`;
}

function added(version) {
  const parts = [[version.objeciones, 'objeciones'], [version.arquetipos, 'arquetipos'], [version.frases, 'frases']].filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return parts.length ? parts.join(' · ') : '—';
}

async function download(numero) {
  const blob = await api.netelip.trainerDocx(numero);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Contexto_Unificado_Entrenador_Llamadas_Grupo_LYN_v${numero}.docx`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function EntrenadorPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.netelip.trainer().then((next) => { setData(next); setError(''); return next; }).catch((requestError) => { setError(requestError.body || requestError.message); return null; });

  useEffect(() => { void load(); }, []);
  // Mientras haya una actualización en curso, se consulta el estado hasta que termine.
  useEffect(() => {
    if (!data?.en_curso) return undefined;
    const timer = setTimeout(() => { void load(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [data]);

  const run = async (key, action) => {
    setBusy(key); setError('');
    try { await action(); await load(); } catch (requestError) { setError(requestError.body || requestError.message); } finally { setBusy(''); }
  };

  if (!data) return <div className={box}>{error ? <p role="alert" className="text-xs text-red-200">{error}</p> : <p role="status" className="text-xs text-[#737373]">Cargando documento del entrenador…</p>}</div>;

  const { vigente, publicado, en_curso: running, llamadas_pendientes: pending } = data;
  const lastFailed = data.versiones?.[0]?.estado === 'error' ? data.versiones[0] : null;
  const disabledReason = !data.can_update ? 'Solo los supervisores pueden actualizar el documento.'
    : !data.modelo_configurado ? 'Falta la clave de Gemini en el servidor.'
      : running ? null : !pending ? 'No hay llamadas evaluadas nuevas desde la última actualización.' : null;

  return <div className="space-y-4">
    <div className={box}>
      <p className={label}>Documento del entrenador de llamadas</p>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-[#BFBFBF]">El archivo que los comerciales cargan en ChatGPT para simular llamadas. Al actualizarlo se añaden objeciones, material de arquetipos y frases sacados de las llamadas evaluadas <strong className="text-[#F2F2F2]">desde la última actualización</strong>, sin datos de clientes y sin borrar nada del documento original.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div><p className={label}>Versión vigente</p><p className="mt-1 text-sm text-[#F2F2F2]">{vigente ? `v${vigente.numero}` : '—'}</p><p className="text-[11px] text-[#737373]">{vigente?.periodo_hasta ? `Con llamadas hasta el ${madridDate(vigente.periodo_hasta)}` : 'Documento original de Jean, sin llamadas'}</p></div>
        <div><p className={label}>Llamadas nuevas</p><p className="mt-1 text-sm text-[#F2F2F2]">{pending}</p><p className="text-[11px] text-[#737373]">Evaluadas desde la última actualización</p></div>
        <div><p className={label}>En Google Drive</p>
          {publicado ? <><a href={publicado.drive_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-amber-300 hover:text-amber-200">Abrir el documento ↗</a><p className="text-[11px] text-[#737373]">v{publicado.numero} · {formatMadridDateTime(publicado.drive_publicado_en)}</p></>
            : <p className="mt-1 text-xs text-[#737373]">{data.drive_configurado ? 'Se publicará en la primera actualización.' : 'Publicación sin configurar: descarga el .docx.'}</p>}
        </div>
      </div>
      {publicado && publicado.drive_en_carpeta === false && <p className="mt-3 rounded border border-amber-300/30 bg-amber-300/[.06] p-3 text-xs text-amber-100">Google no dejó crear el archivo dentro de la carpeta, así que está en la raíz de «Mi unidad» de la cuenta. Muévelo una vez a la carpeta: las siguientes versiones lo seguirán actualizando allí y el enlace no cambia.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" disabled={Boolean(disabledReason) || Boolean(running) || busy === 'update'} onClick={() => run('update', () => api.netelip.updateTrainer())} className="rounded bg-amber-300 px-3 py-2 text-xs font-medium text-black hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40">
          {running ? 'Actualizando…' : `Actualizar con ${pending} ${pending === 1 ? 'llamada nueva' : 'llamadas nuevas'}`}
        </button>
        {running && <p role="status" className="text-xs text-amber-100">Analizando {running.llamadas} llamadas con Gemini y publicando. Suele tardar 1-3 minutos; puedes salir de esta pantalla.</p>}
        {!running && disabledReason && <p className="text-xs text-[#737373]">{disabledReason}</p>}
      </div>
      {lastFailed && !running && <p role="alert" className="mt-3 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">La última actualización (v{lastFailed.numero}) falló: {lastFailed.error}. El documento vigente no ha cambiado; puedes volver a intentarlo.</p>}
      {error && <p role="alert" className="mt-3 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    </div>

    <div className="overflow-hidden rounded-md border border-[#2E2E2E] bg-[#141414]">
      <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left"><thead className="bg-[#0D0D0D] font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]"><tr><th className="px-3 py-3">Versión</th><th className="px-3 py-3">Llamadas</th><th className="px-3 py-3">Añadido</th><th className="px-3 py-3">Resumen</th><th className="px-3 py-3">Drive</th><th className="px-3 py-3" /></tr></thead>
        <tbody className="divide-y divide-[#2E2E2E]">
          {data.versiones.map((version) => <tr key={version.numero} className="align-top">
            <td className="px-3 py-3 text-xs text-[#F2F2F2]"><p className="font-mono">v{version.numero}</p><p className="mt-1 text-[10px] text-[#737373]">{formatMadridDateTime(version.terminado_en || version.creado_en)}{version.autor_nombre ? ` · ${version.autor_nombre}` : ''}</p></td>
            <td className="px-3 py-3 text-xs text-[#BFBFBF]"><p>{periodo(version)}</p>{version.periodo_hasta && <p className="mt-1 text-[10px] text-[#737373]">{version.llamadas} evaluadas</p>}</td>
            <td className="px-3 py-3 text-xs text-[#BFBFBF]">{version.estado === 'lista' ? added(version) : version.estado === 'procesando' ? <span className="text-amber-200">Procesando…</span> : <span className="text-red-200">Falló</span>}</td>
            <td className="max-w-md px-3 py-3 text-xs leading-5 text-[#D4D4D4]">{version.estado === 'error' ? <span className="text-red-200">{version.error}</span> : version.resumen || '—'}</td>
            <td className="px-3 py-3 text-xs">{version.drive_error ? <span className="text-red-200" title={version.drive_error}>Sin publicar</span> : version.drive_publicado_en ? <span className="text-emerald-200">Publicada</span> : <span className="text-[#4A4A4A]">—</span>}</td>
            <td className="px-3 py-3 text-right text-xs">{version.estado === 'lista' && <div className="flex justify-end gap-2">
              {data.can_update && data.drive_configurado && (version.drive_error || version.numero === vigente?.numero) && !version.drive_publicado_en && <button type="button" disabled={Boolean(busy)} onClick={() => run(`publish-${version.numero}`, () => api.netelip.publishTrainer(version.numero))} className={buttonClass}>{busy === `publish-${version.numero}` ? 'Publicando…' : 'Publicar en Drive'}</button>}
              <button type="button" disabled={Boolean(busy)} onClick={() => run(`docx-${version.numero}`, () => download(version.numero))} className={buttonClass}>.docx</button>
            </div>}</td>
          </tr>)}
        </tbody></table></div>
    </div>
  </div>;
}
