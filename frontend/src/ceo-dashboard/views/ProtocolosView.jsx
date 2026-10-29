import { useEffect, useState } from 'react';
import api from '../api';
import ProtocolosAdminPanel from './ProtocolosAdminPanel';

export default function ProtocolosView() {
  const isPreview = window.location.pathname === '/protocolos-preview.html';
  const [status, setStatus] = useState(null);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const checkStatus = () => api.protocols.status().then(nextStatus => {
      if (!active) return;
      setStatus(nextStatus);
      setError('');
      clearInterval(retry);
    }).catch(() => {
      if (active) setError('No se pudo comprobar el estado de los protocolos. Reintentando conexión…');
    });
    const retry = setInterval(checkStatus, 5000);
    void checkStatus();
    return () => { active = false; clearInterval(retry); };
  }, []);

  const ask = async (event) => {
    event.preventDefault();
    if (!question.trim() || loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    setFeedback(null);
    try { setResult(await api.protocols.ask(question.trim())); }
    catch (requestError) { setError(requestError.body || requestError.message); }
    finally { setLoading(false); }
  };

  const confirm = async (resolved) => {
    if (!result || feedback !== null) return;
    try { await api.protocols.feedback(result.id, resolved); setFeedback(resolved); }
    catch (requestError) { setError(requestError.body || requestError.message); }
  };

  const sync = async () => {
    setSyncing(true);
    setError('');
    try {
      const report = await api.protocols.sync();
      if (report?.error) throw new Error(report.error);
      setStatus(await api.protocols.status());
    }
    catch (requestError) { setError(requestError.body || requestError.message); }
    finally { setSyncing(false); }
  };

  const stale = status?.updatedAt && (!status.lastSyncedAt || Date.now() - new Date(status.lastSyncedAt).getTime() > 24 * 60 * 60 * 1000);

  return <section className="ceo-page mx-auto max-w-4xl space-y-6 p-4 sm:p-6 xl:p-8">
    <header className="border-b border-[#2E2E2E] pb-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#737373]">Método LYN</p>
      <h2 className="mt-2 font-display text-2xl text-[#F2F2F2]">Agente de protocolos</h2>
      <p className="mt-2 text-sm text-[#BFBFBF]">Pregunta primero aquí cómo se trabaja. Las respuestas usan solo protocolos vigentes y muestran su fuente. {isPreview ? 'Esta prueba solo guarda consultas temporalmente en memoria.' : 'Las consultas se registran sin datos personales.'}</p>
    </header>
    {status && (!status.enabled || !status.versionId) && <p role="status" className="rounded border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-100">El agente aún no tiene un corpus válido. Tech debe completar la sincronización de la carpeta Protocolos.</p>}
    {stale && <p role="status" className="rounded border border-amber-300/30 p-4 text-sm text-amber-100">Los protocolos no se han actualizado en más de 24 horas.</p>}
    {status?.canManage && <details className="rounded border border-[#2E2E2E] bg-[#141414] p-4 text-xs text-[#BFBFBF]"><summary className="cursor-pointer font-semibold text-[#F2F2F2]">Informe de sincronización · Solo Tech/Dirección</summary><div className="mt-4 space-y-3">{status.report ? <><p>Última revisión: {new Date(status.report.checkedAt).toLocaleString('es-ES')}</p>{status.report.error && <p className="text-amber-200">{status.report.error}</p>}<ul className="space-y-2">{status.report.files.map(file => <li key={file.id} className="rounded border border-[#2E2E2E] p-2"><strong>{file.name}</strong> · {file.status} · {file.sections} secciones · {file.tables} tablas · ~{file.tokens} tokens{file.warnings.map((warning, index) => <p key={index} className="mt-1 text-amber-200">{warning}</p>)}</li>)}</ul></> : <p>Aún no hay sincronizaciones registradas.</p>}<button type="button" onClick={sync} disabled={syncing || !status.enabled} className="rounded border border-[#737373] px-3 py-2 disabled:opacity-40">{syncing ? 'Sincronizando…' : 'Sincronizar ahora'}</button></div></details>}
    <form onSubmit={ask} className="space-y-3">
      <label htmlFor="protocol-question" className="block text-sm font-medium text-[#F2F2F2]">Tu duda</label>
      <textarea id="protocol-question" value={question} onChange={event => setQuestion(event.target.value)} rows={4} maxLength={2000} className="w-full rounded border border-[#2E2E2E] bg-[#141414] p-4 text-sm text-[#F2F2F2] outline-none focus:border-amber-300/60" placeholder="¿Cómo se hace una revisión semanal con el PMC?" />
      <button type="submit" disabled={!status?.enabled || !status?.versionId || !question.trim() || loading} className="rounded bg-[#BFBFBF] px-5 py-2.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40">{loading ? 'Consultando…' : 'Enviar consulta'}</button>
    </form>
    {error && <p role="alert" className="rounded border border-red-800 p-4 text-sm text-red-200">{error}</p>}
    {result && <article className="space-y-5 rounded border border-[#2E2E2E] bg-[#141414] p-5">
      <p className={`text-xs font-semibold uppercase tracking-wider ${result.classification === 'urgente' ? 'text-red-300' : 'text-[#BFBFBF]'}`}>{result.classification.replace('_', ' ')}</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#F2F2F2]">{result.answer}</p>
      {result.sources?.length > 0 && <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#BFBFBF]">Fuentes</h3><ul className="space-y-2">{result.sources.map((source, index) => <li key={`${source.doc_id}-${source.seccion}-${index}`} className="rounded border border-[#2E2E2E] p-3 text-xs text-[#BFBFBF]">{source.doc_id.startsWith('local:') ? <span className="font-medium text-amber-200">{source.name} · {source.seccion}</span> : <a href={`https://drive.google.com/file/d/${encodeURIComponent(source.doc_id)}/view`} target="_blank" rel="noopener noreferrer" className="font-medium text-amber-200 underline">{source.name} · {source.seccion}</a>}{source.modifiedTime && <span className="ml-2 text-[#737373]">{new Date(source.modifiedTime).toLocaleDateString('es-ES')}</span>}<p className="mt-1">“{source.cita}”</p></li>)}</ul></div>}
      {result.contradiction && <p className="text-xs text-amber-200">Hay instrucciones contradictorias en dos documentos. Consulta con el responsable antes de actuar.</p>}
      {result.derivationRole && <p className="text-xs text-[#BFBFBF]">A quién acudir: {result.derivationRole}{result.derivationPerson ? ` · ${result.derivationPerson}` : ''}</p>}
      <div className="border-t border-[#2E2E2E] pt-4"><p className="mb-3 text-sm text-[#F2F2F2]">¿Te ha resuelto la duda?</p>{feedback === null ? <div className="flex gap-2"><button type="button" onClick={() => confirm(true)} className="rounded border border-[#737373] px-4 py-2 text-xs">Sí</button><button type="button" onClick={() => confirm(false)} className="rounded border border-[#737373] px-4 py-2 text-xs">No</button></div> : <p className="text-xs text-[#BFBFBF]">Gracias por confirmar tu respuesta.</p>}</div>
    </article>}
    {(status?.canReadReport || status?.canReadQueries) && <ProtocolosAdminPanel refreshToken={`${result?.id || ''}:${feedback}`} canReadHistory={Boolean(status?.canReadQueries)} />}
  </section>;
}
