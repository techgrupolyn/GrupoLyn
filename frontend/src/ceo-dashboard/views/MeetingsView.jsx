import { useEffect, useMemo, useState } from 'react';
import api from '../api';

const ARTIFACT_TYPES = [
  { key: 'all', label: 'Todo' },
  { key: 'transcript', label: 'Transcripciones' },
  { key: 'notes', label: 'Notas' },
  { key: 'document', label: 'Documentos' },
  { key: 'recording', label: 'Grabaciones' },
  { key: 'audio', label: 'Audios' },
];

function formatDate(value) {
  return value ? new Date(value).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function artifactLabel(type) {
  return ({ transcript: 'Transcripción', notes: 'Notas', recording: 'Grabación', audio: 'Audio', document: 'Documento', other: 'Archivo' })[type] || 'Archivo';
}

function isTextReady(artifact) {
  return ['transcript', 'notes', 'document'].includes(artifact.artifact_type) && Boolean(String(artifact.content_preview || '').trim());
}

export function getArtifactOperationalData(artifact = {}) {
  const metadata = artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata) ? artifact.metadata : {};
  const project = String(metadata.obra || metadata.project || metadata.project_name || '').trim();
  const contact = String(metadata.contacto || metadata.contact || metadata.contact_name || '').trim();
  const rawActions = Array.isArray(metadata.actions) ? metadata.actions : Array.isArray(metadata.action_items) ? metadata.action_items : [];
  const explicitCount = Number(metadata.actions_count);
  const actionCount = Number.isFinite(explicitCount) && explicitCount >= 0 ? explicitCount : rawActions.filter(Boolean).length;
  return {
    project: project || 'Pendiente de identificar',
    contact: contact || 'Sin contacto identificado',
    actionsLabel: actionCount ? `${actionCount} ${actionCount === 1 ? 'acción' : 'acciones'}` : 'Sin acciones extraídas',
    hasProject: Boolean(project),
    hasContact: Boolean(contact),
    hasActions: actionCount > 0,
  };
}

export function summarizeDriveData(artifacts = [], folders = []) {
  const activeFolders = folders.filter((folder) => folder.enabled).length;
  const textReady = artifacts.filter(isTextReady).length;
  const mediaItems = artifacts.filter((artifact) => ['recording', 'audio'].includes(artifact.artifact_type)).length;
  return { total: artifacts.length, activeFolders, textReady, mediaItems };
}

export function filterDriveArtifacts(artifacts = [], { query = '', type = 'all', period = 'all' } = {}, now = new Date()) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase('es-ES');
  const periodDays = period === 'week' ? 7 : period === 'month' ? 30 : 0;
  const threshold = periodDays ? new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000) : null;

  return artifacts.filter((artifact) => {
    if (type !== 'all' && artifact.artifact_type !== type) return false;
    if (threshold && (!artifact.source_modified_at || new Date(artifact.source_modified_at) < threshold)) return false;
    if (!normalizedQuery) return true;
    const searchable = [artifact.name, artifact.folder_label, artifact.google_email, artifactLabel(artifact.artifact_type)]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('es-ES');
    return searchable.includes(normalizedQuery);
  });
}

function MetricCard({ label, value, detail, tone = 'default' }) {
  const valueClass = tone === 'warm' ? 'text-[#F2F2F2]' : tone === 'muted' ? 'text-[#BFBFBF]' : 'text-[#F2F2F2]';
  return (
    <div className="min-w-0 rounded-md border border-[#2E2E2E] bg-[#141414] px-4 py-3.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#737373]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</p>
      <p className="mt-1 truncate text-[11px] text-[#737373]">{detail}</p>
    </div>
  );
}

function ArtifactStatus({ artifact }) {
  if (isTextReady(artifact)) return <span className="inline-flex items-center gap-1.5 text-[11px] text-[#BFBFBF]"><span className="size-1.5 rounded-full bg-[#BFBFBF]" />Lista para revisar</span>;
  if (['recording', 'audio'].includes(artifact.artifact_type)) return <span className="inline-flex items-center gap-1.5 text-[11px] text-[#737373]"><span className="size-1.5 rounded-full border border-[#737373]" />Referencia en Drive</span>;
  return <span className="inline-flex items-center gap-1.5 text-[11px] text-[#737373]"><span className="size-1.5 rounded-full bg-[#2E2E2E]" />Sin texto extraído</span>;
}

export default function MeetingsView() {
  const [status, setStatus] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [folderForm, setFolderForm] = useState({ connection_id: '', label: '', folder_url: '' });
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [period, setPeriod] = useState('all');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, nextArtifacts] = await Promise.all([api.googleDrive.status(), api.googleDrive.artifacts()]);
      setStatus(nextStatus || {});
      setArtifacts(Array.isArray(nextArtifacts) ? nextArtifacts : []);
      setFolderForm((current) => ({ ...current, connection_id: current.connection_id || nextStatus?.connections?.[0]?.id || '' }));
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo cargar Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredArtifacts = useMemo(() => filterDriveArtifacts(artifacts, { query, type, period }), [artifacts, query, type, period]);
  const summary = useMemo(() => summarizeDriveData(artifacts, status?.folders || []), [artifacts, status?.folders]);
  const connected = (status?.connections || []).length > 0;
  const hasFolders = (status?.folders || []).length > 0;

  const connect = async () => {
    setAction('connect');
    setError('');
    try {
      const response = await api.googleDrive.connect();
      if (!response?.authorization_url) throw new Error('No se recibió la URL de autorización.');
      window.location.assign(response.authorization_url);
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo iniciar la conexión.');
      setAction('');
    }
  };

  const addFolder = async (event) => {
    event.preventDefault();
    setAction('folder');
    setError('');
    try {
      await api.googleDrive.addFolder(folderForm);
      setFolderForm((current) => ({ ...current, label: '', folder_url: '' }));
      setShowSetup(false);
      await load();
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo registrar la carpeta.');
    } finally {
      setAction('');
    }
  };

  const syncFolder = async (folderId) => {
    setAction(`sync-${folderId}`);
    setError('');
    try {
      await api.googleDrive.syncFolder(folderId);
      await load();
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo sincronizar la carpeta.');
    } finally {
      setAction('');
    }
  };

  const disableFolder = async (folderId) => {
    if (!window.confirm('¿Dejar de sincronizar esta carpeta? Los registros ya importados se conservarán.')) return;
    setAction(`disable-${folderId}`);
    try {
      await api.googleDrive.removeFolder(folderId);
      await load();
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo desactivar la carpeta.');
    } finally {
      setAction('');
    }
  };

  const openArtifact = async (artifact) => {
    setAction(`artifact-${artifact.id}`);
    try {
      setSelected(await api.googleDrive.artifact(artifact.id));
    } catch (requestError) {
      setError(requestError?.body || requestError?.message || 'No se pudo abrir el documento.');
    } finally {
      setAction('');
    }
  };

  return (
    <section className="p-4 sm:p-6 xl:p-8">
      <div className="ceo-page">
        <div className="mb-5 flex flex-col gap-4 border-b border-[#2E2E2E] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#737373]">Agente de reuniones</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-[#F2F2F2]">Gestión de reuniones</h2>
            <p className="mt-1 text-xs text-[#737373]">Centraliza las transcripciones y documentos de Google Drive con acceso de solo lectura.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={load} disabled={loading} className="rounded border border-[#2E2E2E] bg-[#141414] px-3 py-2 text-xs font-medium text-[#BFBFBF] transition hover:border-[#737373] disabled:opacity-40">
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
            <button type="button" onClick={() => setShowSetup((current) => !current)} className="rounded bg-[#BFBFBF] px-3 py-2 text-xs font-semibold text-black transition hover:bg-[#F2F2F2]">
              {showSetup ? 'Cerrar configuración' : 'Configurar fuentes'}
            </button>
          </div>
        </div>

        {(showSetup || !hasFolders) && (
          <div className="mb-5 grid gap-4 xl:grid-cols-2">
            <div className="rounded-md border border-[#2E2E2E] bg-[#141414] p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#737373]">01 · Cuenta Google</p>
              <h3 className="mt-2 text-sm font-semibold text-[#F2F2F2]">Conexión de solo lectura</h3>
              <p className="mt-2 max-w-xl text-xs leading-5 text-[#737373]">Las grabaciones permanecen en Drive. El sistema solo guarda texto de transcripciones, notas y documentos compatibles.</p>
              {!loading && !status?.configured && <p className="mt-3 text-xs text-amber-200">{status?.configuration_error}</p>}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={connect} disabled={!status?.configured || action === 'connect'} className="rounded border border-[#BFBFBF]/40 px-3 py-2 text-xs font-medium text-[#F2F2F2] transition hover:border-[#BFBFBF] disabled:opacity-40">
                  {action === 'connect' ? 'Abriendo Google…' : connected ? 'Añadir otra cuenta' : 'Conectar Google Drive'}
                </button>
                <span className="text-xs text-[#737373]">{connected ? `${status.connections.length} cuenta${status.connections.length === 1 ? '' : 's'} conectada${status.connections.length === 1 ? '' : 's'}` : 'Sin cuentas conectadas'}</span>
              </div>
              {connected && <div className="mt-4 space-y-1 border-t border-[#2E2E2E] pt-3 text-xs text-[#BFBFBF]">{status.connections.map((connection) => <p key={connection.id}>{connection.display_name || connection.google_email} <span className="text-[#737373]">· {connection.google_email}</span></p>)}</div>}
            </div>

            <form onSubmit={addFolder} className="rounded-md border border-[#2E2E2E] bg-[#141414] p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#737373]">02 · Carpeta fuente</p>
              <h3 className="mt-2 text-sm font-semibold text-[#F2F2F2]">Añadir carpeta de reuniones</h3>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <select required value={folderForm.connection_id} onChange={(event) => setFolderForm((current) => ({ ...current, connection_id: event.target.value }))} className="h-10 rounded border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none focus:border-[#737373] sm:col-span-2">
                  <option value="">Selecciona una cuenta Google</option>
                  {(status?.connections || []).map((connection) => <option key={connection.id} value={connection.id}>{connection.google_email}</option>)}
                </select>
                <input required value={folderForm.label} onChange={(event) => setFolderForm((current) => ({ ...current, label: event.target.value }))} placeholder="Nombre interno de la carpeta" maxLength={255} className="h-10 rounded border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373] focus:border-[#737373]" />
                <input required value={folderForm.folder_url} onChange={(event) => setFolderForm((current) => ({ ...current, folder_url: event.target.value }))} placeholder="URL o ID de Google Drive" className="h-10 rounded border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373] focus:border-[#737373]" />
              </div>
              <button type="submit" disabled={!status?.configured || !connected || action === 'folder'} className="mt-3 rounded bg-[#BFBFBF] px-3 py-2 text-xs font-semibold text-black transition hover:bg-[#F2F2F2] disabled:opacity-40">
                {action === 'folder' ? 'Guardando…' : 'Añadir carpeta'}
              </button>
            </form>
          </div>
        )}

        {error && <p role="alert" className="mb-5 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Archivos importados" value={summary.total} detail="Registros disponibles en la base central" />
          <MetricCard label="Carpetas activas" value={summary.activeFolders} detail={summary.activeFolders ? 'Fuentes habilitadas para sincronizar' : 'Configura una carpeta para comenzar'} />
          <MetricCard label="Listos para revisión" value={summary.textReady} detail="Transcripciones, notas o documentos con texto" tone="warm" />
          <MetricCard label="Media en Drive" value={summary.mediaItems} detail="Audios y grabaciones no se envían a IA" tone="muted" />
        </div>

        <div className="mt-5 overflow-hidden rounded-md border border-[#2E2E2E] bg-[#141414]">
          <div className="flex flex-col gap-3 border-b border-[#2E2E2E] p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5">
              {ARTIFACT_TYPES.map((item) => <button key={item.key} type="button" onClick={() => setType(item.key)} className={`rounded px-2.5 py-1.5 text-xs transition ${type === item.key ? 'bg-[#2E2E2E] text-[#F2F2F2]' : 'text-[#737373] hover:bg-[#0D0D0D] hover:text-[#BFBFBF]'}`}>{item.label}</button>)}
              <span className="mx-1 hidden h-6 w-px bg-[#2E2E2E] sm:block" />
              {[{ key: 'all', label: 'Todo el historial' }, { key: 'week', label: 'Últimos 7 días' }, { key: 'month', label: 'Últimos 30 días' }].map((item) => <button key={item.key} type="button" onClick={() => setPeriod(item.key)} className={`rounded px-2.5 py-1.5 text-xs transition ${period === item.key ? 'bg-[#0D0D0D] text-[#BFBFBF] ring-1 ring-[#2E2E2E]' : 'text-[#737373] hover:text-[#BFBFBF]'}`}>{item.label}</button>)}
            </div>
            <label className="relative block lg:w-80">
              <span className="sr-only">Buscar en reuniones importadas</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#737373]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar reunión, carpeta o cuenta…" className="h-9 w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] pl-9 pr-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373] focus:border-[#737373]" />
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-left">
              <thead className="bg-[#0D0D0D] text-[10px] uppercase tracking-[0.13em] text-[#737373]">
                <tr><th className="px-3 py-3 font-medium">Reunión / archivo</th><th className="px-3 py-3 font-medium">Obra</th><th className="px-3 py-3 font-medium">Contacto</th><th className="px-3 py-3 font-medium">Acciones</th><th className="px-3 py-3 font-medium">Tipo</th><th className="px-3 py-3 font-medium">Estado</th><th className="px-3 py-3 font-medium">Actualizado</th><th className="px-3 py-3 text-right font-medium">Acción</th></tr>
              </thead>
              <tbody className="divide-y divide-[#2E2E2E]">
                {filteredArtifacts.map((artifact) => {
                  const operations = getArtifactOperationalData(artifact);
                  return <tr key={artifact.id} className="group cursor-pointer transition hover:bg-[#0D0D0D]" onClick={() => openArtifact(artifact)}>
                    <td className="border-l-2 border-l-transparent px-3 py-3 group-hover:border-l-[#BFBFBF]"><p className="max-w-xs truncate text-sm font-medium text-[#F2F2F2]">{artifact.name}</p><p className="mt-0.5 max-w-xs truncate text-[11px] text-[#737373]">{artifact.folder_label || 'Carpeta no disponible'} · {artifact.google_email || 'Cuenta Google'}</p></td>
                    <td className={`px-3 py-3 text-xs ${operations.hasProject ? 'text-[#F2F2F2]' : 'text-[#737373]'}`}>{operations.project}</td>
                    <td className={`px-3 py-3 text-xs ${operations.hasContact ? 'text-[#F2F2F2]' : 'text-[#737373]'}`}>{operations.contact}</td>
                    <td className={`px-3 py-3 text-xs ${operations.hasActions ? 'font-medium text-[#F2F2F2]' : 'text-[#737373]'}`}>{operations.actionsLabel}</td>
                    <td className="px-3 py-3"><span className="rounded border border-[#2E2E2E] bg-[#141414] px-2 py-1 text-[10px] uppercase tracking-wide text-[#BFBFBF]">{artifactLabel(artifact.artifact_type)}</span></td>
                    <td className="px-3 py-3"><ArtifactStatus artifact={artifact} /></td>
                    <td className="px-3 py-3 font-mono text-[11px] text-[#BFBFBF]">{formatDate(artifact.source_modified_at)}</td>
                    <td className="px-3 py-3 text-right"><button type="button" onClick={(event) => { event.stopPropagation(); openArtifact(artifact); }} disabled={action === `artifact-${artifact.id}`} className="rounded border border-[#2E2E2E] px-2.5 py-1.5 text-[11px] text-[#BFBFBF] transition hover:border-[#737373] hover:text-[#F2F2F2] disabled:opacity-40">{action === `artifact-${artifact.id}` ? 'Abriendo…' : 'Abrir'}</button></td>
                  </tr>;
                })}
                {!loading && !filteredArtifacts.length && <tr><td colSpan="8" className="px-3 py-12 text-center text-xs text-[#737373]">{artifacts.length ? 'No hay resultados para los filtros seleccionados.' : 'Aún no hay reuniones ni documentos importados.'}</td></tr>}
                {loading && <tr><td colSpan="8" className="px-3 py-12 text-center text-xs text-[#737373]">Cargando reuniones…</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-[#2E2E2E] px-3 py-2 text-[11px] text-[#737373]">Mostrando {filteredArtifacts.length} de {artifacts.length} archivos. Los documentos se ordenan por su última modificación en Google Drive.</p>
        </div>

        <div className="mt-5 rounded-md border border-[#2E2E2E] bg-[#141414]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2E2E2E] px-4 py-3">
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">Fuentes sincronizadas</p><p className="mt-1 text-xs text-[#737373]">Administra las carpetas sin eliminar los archivos ya importados.</p></div>
          </div>
          <div className="divide-y divide-[#2E2E2E]">
            {(status?.folders || []).map((folder) => (
              <div key={folder.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><p className="truncate text-sm font-medium text-[#F2F2F2]">{folder.label}</p><p className="mt-1 text-xs text-[#737373]">{folder.artifacts_count || 0} archivos · última sincronización: {formatDate(folder.last_synced_at)}</p>{folder.last_sync_error && <p className="mt-1 text-xs text-red-200">{folder.last_sync_error}</p>}</div>
                <div className="flex shrink-0 gap-2"><button type="button" onClick={() => syncFolder(folder.id)} disabled={!folder.enabled || action === `sync-${folder.id}`} className="rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] transition hover:border-[#737373] disabled:opacity-40">{action === `sync-${folder.id}` ? 'Sincronizando…' : 'Sincronizar'}</button><button type="button" onClick={() => disableFolder(folder.id)} disabled={!folder.enabled || action === `disable-${folder.id}`} className="rounded border border-red-950/70 px-3 py-2 text-xs text-red-200 transition hover:border-red-800 disabled:opacity-40">Desactivar</button></div>
              </div>
            ))}
            {!loading && !hasFolders && <p className="px-4 py-5 text-xs text-[#737373]">Configura una carpeta fuente para iniciar la sincronización.</p>}
          </div>
        </div>
      </div>

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 sm:p-6"><div role="dialog" aria-modal="true" aria-label="Detalle del archivo" className="max-h-[88vh] w-full max-w-4xl overflow-y-auto rounded-md border border-[#2E2E2E] bg-[#141414] shadow-2xl"><div className="sticky top-0 flex items-start justify-between gap-4 border-b border-[#2E2E2E] bg-[#141414] p-5"><div className="min-w-0"><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[#737373]">{artifactLabel(selected.artifact_type)} · {selected.folder_label || 'Google Drive'}</p><h3 className="mt-1 truncate text-lg font-semibold text-[#F2F2F2]">{selected.name}</h3></div><button type="button" onClick={() => setSelected(null)} className="rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] hover:border-[#737373]">Cerrar</button></div><div className="p-5">{selected.web_view_link && <a href={selected.web_view_link} target="_blank" rel="noreferrer" className="inline-flex rounded border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] hover:border-[#737373]">Abrir original en Google Drive</a>}<pre className="mt-4 whitespace-pre-wrap rounded border border-[#2E2E2E] bg-[#0D0D0D] p-4 text-xs leading-5 text-[#D4D4D4]">{selected.content_text || 'Este tipo de archivo se conserva como referencia. Su contenido no se extrae automáticamente.'}</pre>{selected.content_truncated && <p className="mt-3 text-xs text-amber-200">El texto se guardó parcialmente por el límite de seguridad configurado.</p>}</div></div></div>}
    </section>
  );
}
