import { useEffect, useState } from 'react';
import api from '../api';

function formatDate(value) {
  return value ? new Date(value).toLocaleString('es-ES') : '—';
}

function artifactLabel(type) {
  return ({ transcript: 'Transcripción', notes: 'Notas', recording: 'Grabación', audio: 'Audio', document: 'Documento', other: 'Archivo' })[type] || 'Archivo';
}

export default function MeetingsView() {
  const [status, setStatus] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [folderForm, setFolderForm] = useState({ connection_id: '', label: '', folder_url: '' });
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

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
    <section className="p-10">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Google Drive</p>
          <h3 className="mt-3 font-display text-xl text-[#F2F2F2]">Reuniones y transcripciones</h3>
          <p className="mt-3 text-xs leading-5 text-[#737373]">La conexión es de solo lectura. Las grabaciones permanecen en Drive; el sistema no las envía a IA automáticamente.</p>
          {!loading && !status?.configured && <p className="mt-4 text-xs text-amber-300">{status?.configuration_error}</p>}
          <button type="button" onClick={connect} disabled={!status?.configured || action === 'connect'} className="mt-5 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {action === 'connect' ? 'Abriendo Google…' : 'Conectar Google Drive'}
          </button>
          <div className="mt-5 space-y-2 text-xs text-[#737373]">
            {(status?.connections || []).map((connection) => <p key={connection.id}>{connection.display_name || connection.google_email} · {connection.google_email}</p>)}
            {!loading && !(status?.connections || []).length && <p>Aún no hay ninguna cuenta conectada.</p>}
          </div>
        </div>

        <form onSubmit={addFolder} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Carpetas fuente</p>
          <p className="mt-3 text-xs leading-5 text-[#737373]">Añade la URL o ID de cada carpeta compartida de Google Meet.</p>
          <select required value={folderForm.connection_id} onChange={(event) => setFolderForm((current) => ({ ...current, connection_id: event.target.value }))} className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none">
            <option value="">Selecciona una cuenta Google</option>
            {(status?.connections || []).map((connection) => <option key={connection.id} value={connection.id}>{connection.google_email}</option>)}
          </select>
          <input required value={folderForm.label} onChange={(event) => setFolderForm((current) => ({ ...current, label: event.target.value }))} placeholder="Ej.: Reuniones Ventas Madrid" maxLength={255} className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
          <input required value={folderForm.folder_url} onChange={(event) => setFolderForm((current) => ({ ...current, folder_url: event.target.value }))} placeholder="URL o ID de carpeta Google Drive" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
          <button type="submit" disabled={!status?.configured || !(status?.connections || []).length || action === 'folder'} className="mt-3 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {action === 'folder' ? 'Guardando…' : 'Añadir carpeta'}
          </button>
        </form>
      </div>

      {error && <p className="mt-6 rounded-sm border border-red-900 bg-red-950/30 p-4 text-xs text-red-300">{error}</p>}

      <div className="mt-6 rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Sincronización</p><p className="mt-2 text-xs text-[#737373]">{status?.artifacts_count || 0} archivos registrados.</p></div>
          <button type="button" onClick={load} disabled={loading} className="border border-[#2E2E2E] px-3 py-2 text-xs text-[#BFBFBF] disabled:opacity-40">Actualizar</button>
        </div>
        <div className="mt-5 space-y-3">
          {(status?.folders || []).map((folder) => (
            <div key={folder.id} className="flex flex-wrap items-center justify-between gap-3 border border-[#2E2E2E] bg-[#0D0D0D] p-4 text-xs">
              <div><p className="text-[#F2F2F2]">{folder.label}</p><p className="mt-1 text-[#737373]">{folder.artifacts_count || 0} archivos · última sincronización: {formatDate(folder.last_synced_at)}</p>{folder.last_sync_error && <p className="mt-1 text-red-300">{folder.last_sync_error}</p>}</div>
              <div className="flex gap-2"><button type="button" onClick={() => syncFolder(folder.id)} disabled={!folder.enabled || action === `sync-${folder.id}`} className="border border-[#2E2E2E] px-3 py-2 text-[#BFBFBF] disabled:opacity-40">{action === `sync-${folder.id}` ? 'Sincronizando…' : 'Sincronizar'}</button><button type="button" onClick={() => disableFolder(folder.id)} disabled={!folder.enabled || action === `disable-${folder.id}`} className="border border-red-950 px-3 py-2 text-red-300 disabled:opacity-40">Desactivar</button></div>
            </div>
          ))}
          {!loading && !(status?.folders || []).length && <p className="text-xs text-[#737373]">Añade una carpeta para iniciar la importación.</p>}
        </div>
      </div>

      <div className="mt-6 rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Archivos importados</p>
        <div className="mt-5 space-y-2">
          {artifacts.map((artifact) => <button type="button" key={artifact.id} onClick={() => openArtifact(artifact)} className="flex w-full items-center justify-between gap-4 border border-[#2E2E2E] bg-[#0D0D0D] p-4 text-left text-xs transition-colors hover:border-[#737373]"><span className="min-w-0"><span className="block truncate text-[#F2F2F2]">{artifact.name}</span><span className="mt-1 block text-[#737373]">{artifactLabel(artifact.artifact_type)} · {artifact.folder_label || 'Carpeta no disponible'} · {formatDate(artifact.source_modified_at)}</span></span><span className="shrink-0 text-[#BFBFBF]">Abrir</span></button>)}
          {!loading && !artifacts.length && <p className="text-xs text-[#737373]">Aún no hay reuniones ni documentos importados.</p>}
        </div>
      </div>

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"><div className="max-h-[85vh] w-full max-w-4xl overflow-y-auto border border-[#2E2E2E] bg-[#141414] p-6"><div className="flex items-start justify-between gap-4"><div><h3 className="text-lg text-[#F2F2F2]">{selected.name}</h3><p className="mt-2 text-xs text-[#737373]">{artifactLabel(selected.artifact_type)} · {selected.folder_label || 'Google Drive'}</p></div><button type="button" onClick={() => setSelected(null)} className="text-xs text-[#BFBFBF]">Cerrar</button></div>{selected.web_view_link && <a href={selected.web_view_link} target="_blank" rel="noreferrer" className="mt-5 inline-block text-xs text-[#BFBFBF] underline">Abrir archivo original en Google Drive</a>}<pre className="mt-5 whitespace-pre-wrap border border-[#2E2E2E] bg-[#0D0D0D] p-4 text-xs leading-5 text-[#D4D4D4]">{selected.content_text || 'Este tipo de archivo se conserva como referencia. Su contenido no se extrae automáticamente.'}</pre>{selected.content_truncated && <p className="mt-3 text-xs text-amber-300">El texto se guardó parcialmente por límite de seguridad.</p>}</div></div>}
    </section>
  );
}