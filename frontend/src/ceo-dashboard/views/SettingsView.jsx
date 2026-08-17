import { useEffect, useState } from 'react';
import api from '../api';

export default function SettingsView() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    rejectCall: false,
    msgCall: '',
    groupsIgnore: false,
    alwaysOnline: false,
    readMessages: true,
    readStatus: true,
    syncFullHistory: false,
  });
  const [presenceForm, setPresenceForm] = useState({ presence: 'available', delay: 0, number: '' });
  const [proxyForm, setProxyForm] = useState({ enabled: false, host: '', port: '', protocol: 'http', username: '', password: '' });
  const [privacy, setPrivacy] = useState(null);
  const [invitationLabel, setInvitationLabel] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [invitationError, setInvitationError] = useState('');
  const [creatingInvitation, setCreatingInvitation] = useState(false);
  const [invitations, setInvitations] = useState([]);
  const [invitationsLoading, setInvitationsLoading] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [accountForm, setAccountForm] = useState({ id: '', nombre: '', evolution_instance_name: '' });

  const loadSettings = async () => {
    try {
      const data = await api.settings.find();
      setSettings(data || {});
      setForm((prev) => ({ ...prev, ...(data || {}) }));
    } catch { /* ignore */ }
  };

  const loadAccounts = async () => {
    try {
      const data = await api.whatsappAccounts.list();
      const next = Array.isArray(data) ? data : [];
      setAccounts(next);
      setSelectedAccountId((current) => current || next.find((account) => account.activo)?.id || '');
    } catch { setAccounts([]); }
  };

  const createAccount = async (event) => {
    event.preventDefault();
    setInvitationError('');
    try {
      const account = await api.whatsappAccounts.create(accountForm);
      setAccountForm({ id: '', nombre: '', evolution_instance_name: '' });
      setSelectedAccountId(account.id);
      await loadAccounts();
    } catch (error) { setInvitationError(error?.body || error?.message || 'No se pudo crear la cuenta.'); }
  };

  const loadInvitations = async () => {
    setInvitationsLoading(true);
    try {
      const data = await api.extensionInvitations.list();
      setInvitations(Array.isArray(data) ? data : []);
    } catch {
      setInvitations([]);
    } finally {
      setInvitationsLoading(false);
    }
  };
  const loadPrivacy = async () => {
    try {
      const data = await api.chat.privacySettings();
      setPrivacy(data || {});
    } catch { /* ignore */ }
  };

  useEffect(() => { loadSettings(); loadPrivacy(); loadInvitations(); loadAccounts(); }, []);

  const saveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.settings.set(form);
      await loadSettings();
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  const setPresence = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.chat.sendPresence(presenceForm.number, presenceForm.presence, presenceForm.delay);
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  const createInvitation = async (e) => {
    e.preventDefault();
    setCreatingInvitation(true);
    setInvitationError('');
    setInvitationCode('');
    try {
      const invitation = await api.extensionInvitations.create(invitationLabel, selectedAccountId, 24);
      setInvitationCode(String(invitation?.code || ''));
      if (!invitation?.code) setInvitationError('No se pudo generar el código. Verificá PUBLIC_APP_URL.');
      await loadInvitations();
    } catch (error) {
      setInvitationError(error?.body || error?.message || 'No se pudo generar el código.');
    } finally {
      setCreatingInvitation(false);
    }
  };
  const revokeInvitation = async (id) => {
    try {
      await api.extensionInvitations.revoke(id);
      await loadInvitations();
    } catch (error) {
      setInvitationError(error?.body || error?.message || 'No se pudo invalidar el código.');
    }
  };
  const saveProxy = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.proxySet(proxyForm);
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  return (
    <div className="p-10">
      <h2 className="font-display text-2xl font-medium text-[#F2F2F2] tracking-wide">Configuración</h2>
      <p className="mt-2 text-xs text-[#737373]">Ajustes de la instancia, privacidad, presencia, proxy y webhooks.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form onSubmit={saveSettings} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Instancia</p>
          {Object.keys(form).map((k) => (
            <label key={k} className="mt-3 flex items-center gap-2 text-xs text-[#737373]">
              <input type="checkbox" checked={Boolean(form[k])} onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.checked }))} />
              {k}
            </label>
          ))}
          <button type="submit" disabled={saving} className="mt-4 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? 'Guardando...' : 'Guardar configuración'}
          </button>
        </form>

        <form onSubmit={setPresence} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Presencia</p>
          <input value={presenceForm.number} onChange={(e) => setPresenceForm((s) => ({ ...s, number: e.target.value }))} placeholder="Número" className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <select value={presenceForm.presence} onChange={(e) => setPresenceForm((s) => ({ ...s, presence: e.target.value }))} className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none">
            <option value="available">Disponible</option>
            <option value="unavailable">No disponible</option>
            <option value="composing">Escribiendo</option>
            <option value="recording">Grabando</option>
            <option value="paused">Pausado</option>
          </select>
          <button type="submit" disabled={saving} className="mt-4 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">Enviar presencia</button>
        </form>

        <form onSubmit={saveProxy} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Proxy</p>
          <label className="mt-3 flex items-center gap-2 text-xs text-[#737373]">
            <input type="checkbox" checked={proxyForm.enabled} onChange={(e) => setProxyForm((s) => ({ ...s, enabled: e.target.checked }))} />
            Habilitar proxy
          </label>
          <input value={proxyForm.host} onChange={(e) => setProxyForm((s) => ({ ...s, host: e.target.value }))} placeholder="Host" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <input value={proxyForm.port} onChange={(e) => setProxyForm((s) => ({ ...s, port: e.target.value }))} placeholder="Puerto" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <input value={proxyForm.username} onChange={(e) => setProxyForm((s) => ({ ...s, username: e.target.value }))} placeholder="Usuario" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <input value={proxyForm.password} onChange={(e) => setProxyForm((s) => ({ ...s, password: e.target.value }))} placeholder="Contraseña" type="password" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <button type="submit" disabled={saving} className="mt-4 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">Guardar proxy</button>
        </form>

        <form onSubmit={createAccount} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Cuentas WhatsApp</p>
          <p className="mt-3 text-xs leading-5 text-[#737373]">Cada cuenta usa una instancia Evolution propia y comparte esta base central sin mezclar chats.</p>
          <input required value={accountForm.id} onChange={(e) => setAccountForm((current) => ({ ...current, id: e.target.value.toLowerCase() }))} placeholder="ID: ventas-caracas" className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
          <input required value={accountForm.nombre} onChange={(e) => setAccountForm((current) => ({ ...current, nombre: e.target.value }))} placeholder="Nombre visible" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
          <input required value={accountForm.evolution_instance_name} onChange={(e) => setAccountForm((current) => ({ ...current, evolution_instance_name: e.target.value }))} placeholder="Instancia Evolution" className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none" />
          <button type="submit" className="mt-3 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black">Crear cuenta</button>
          <div className="mt-4 space-y-1 text-xs text-[#737373]">{accounts.map((account) => <p key={account.id}>{account.nombre} · {account.evolution_instance_name} · {account.activo ? 'Activo' : 'Inactiva'} · {account.chats_count || 0} chats</p>)}</div>
        </form>

        <form onSubmit={createInvitation} className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Activar extensión</p>
          <p className="mt-3 text-xs leading-5 text-[#737373]">Generá un código de un solo uso para un empleado. Lo pega una vez en la extensión y luego solo escanea el QR.</p>
          <input value={invitationLabel} onChange={(e) => setInvitationLabel(e.target.value)} placeholder="Nombre del empleado o equipo" maxLength={160} className="mt-4 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none placeholder:text-[#737373]" />
          <select required value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className="mt-3 h-10 w-full rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-xs text-[#F2F2F2] outline-none"><option value="">Selecciona una cuenta</option>{accounts.filter((account) => account.activo).map((account) => <option key={account.id} value={account.id}>{account.nombre} · {account.evolution_instance_name}</option>)}</select>
          <button type="submit" disabled={creatingInvitation} className="mt-3 rounded-sm bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40">{creatingInvitation ? 'Generando...' : 'Generar código'}</button>
          {invitationCode && <textarea readOnly value={invitationCode} onFocus={(e) => e.target.select()} className="mt-4 h-24 w-full resize-none rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-[11px] text-[#F2F2F2] outline-none" aria-label="Código de activación" />}
          {invitationError && <p className="mt-3 text-xs text-red-400">{invitationError}</p>}
        </form>

        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Códigos y activaciones</p>
            <button type="button" onClick={loadInvitations} disabled={invitationsLoading} className="px-3 py-1 text-[10px]">Actualizar</button>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#737373]">Por seguridad, el contenido del código solo se muestra al crearlo. Aquí ves su estado y podés invalidar códigos que aún no fueron usados.</p>
          <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
            {invitations.map((invitation) => {
              const status = invitation.revoked_at ? 'Invalidado' : invitation.redeemed_at ? 'Activado' : new Date(invitation.expires_at) <= new Date() ? 'Vencido' : 'Pendiente';
              return <div key={invitation.id} className="rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[#F2F2F2]">{invitation.label || 'Sin etiqueta'}</p>
                    <p className="mt-1 text-[#737373]">{status} · creado {new Date(invitation.created_at).toLocaleString()}</p>
                    {invitation.activated_at && <p className="mt-1 text-[#737373]">Vinculado {new Date(invitation.activated_at).toLocaleString()}</p>}
                  </div>
                  {status === 'Pendiente' && <button type="button" onClick={() => revokeInvitation(invitation.id)} className="danger px-3 py-1 text-[10px]">Invalidar</button>}
                </div>
              </div>;
            })}
            {!invitationsLoading && !invitations.length && <p className="text-xs text-[#737373]">Todavía no hay códigos generados.</p>}
          </div>
        </div>

        <div className="rounded-sm border border-[#2E2E2E] bg-[#141414] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[#737373]">Privacidad</p>
          <pre className="mt-4 max-h-64 overflow-y-auto rounded-sm border border-[#2E2E2E] bg-[#0D0D0D] p-3 text-[10px] text-[#737373]">{JSON.stringify(privacy, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
