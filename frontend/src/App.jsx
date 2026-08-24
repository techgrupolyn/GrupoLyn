import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { CeoLogin, hasUsableCeoToken, initialDashboardView, isCeoView, shouldPollWhatsappConnection, shouldShowCeoDashboard, shouldShowCeoLogin } from './ceo-dashboard/CeoLogin';
import api from './api';
const CEOApp = lazy(() => import('./ceo-dashboard/App'));

const API_BASE = import.meta.env.VITE_API_ORIGIN || '';
const SSE_BASE = import.meta.env.VITE_API_ORIGIN || '/api';
const INSTANCE = 'lyn-local';

function CEODashboard(props) {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#0d0f12] text-sm text-[#8696a0]">Cargando dashboard CEO...</div>}>
      <CEOApp {...props} />
    </Suspense>
  );
}

const COLORS = {
  chatBg: '#0b141a',
  sidebarBg: '#111b21',
  sidebarHeader: '#202c33',
  panelBg: '#111b21',
  panelHeader: '#202c33',
  incomingBubble: '#202c33',
  outgoingBubble: '#005c4b',
  textPrimary: '#e9edef',
  textSecondary: '#8696a0',
  inputBg: '#2a3942',
  inputBorder: '#3b4a52',
  green: '#00a884',
  checkBlue: '#53bdeb',
  checkGray: '#8696a0',
  red: '#ef4444',
  white: '#ffffff',
  black: '#000000',
};

function safeISOTimestamp(value) {
  if (value == null) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function isWhatsAppMediaUrl(url) {
  if (typeof url !== 'string') return false;
  return url.includes('mmg.whatsapp.net') || url.includes('a.whatsapp.net');
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // ignore audio errors
  }
}

function formatJid(jid = '') {
  if (!jid) return '';
  const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
  if (/^\d+$/.test(phone) && phone.length >= 10) {
    if (phone.length === 13 && phone.startsWith('549')) {
      return `+${phone.slice(0, 2)} ${phone.slice(2, 4)} ${phone.slice(4, 6)}-${phone.slice(6, 10)}-${phone.slice(10)}`;
    }
    if (phone.length === 12 && phone.startsWith('54')) {
      return `+${phone.slice(0, 2)} ${phone.slice(2, 4)} ${phone.slice(4, 8)}-${phone.slice(8, 12)}`;
    }
    if (phone.length >= 10) {
      return `+${phone}`;
    }
  }
  return phone || jid;
}

function chatDisplayName(chat = {}) {
  const raw = chat.nombre || chat.name || chat.pushName || '';
  const cleanRaw = raw.replace(/@s\.whatsapp\.net$/i, '').replace(/@g\.us$/i, '').replace(/@lid$/i, '').trim();
  if (cleanRaw) {
    if (/^\d+$/.test(cleanRaw)) return formatJid(cleanRaw);
    return cleanRaw;
  }
  const display = formatJid(chat.id || '');
  return display || 'Sin nombre';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Hoy';
  if (date.toDateString() === yesterday.toDateString()) return 'Ayer';
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

const AVATAR_COLORS = [
  '#4a7c59',
  '#7952cc',
  '#d35c5c',
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#6366f1',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
];

function getInitials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const first = parts[0] || '';
  return first.slice(0, 2).toUpperCase();
}

function Avatar({ name, size = 48, imageUrl }) {
  const initials = getInitials(name);
  const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const bg = AVATAR_COLORS[colorIndex];
  const safeImageUrl = typeof imageUrl === 'string' && isWhatsAppMediaUrl(imageUrl) ? null : imageUrl;

  if (safeImageUrl) {
    return (
      <img
        src={safeImageUrl}
        alt={name || 'avatar'}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-white"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.4 }}
    >
      {initials}
    </div>
  );
}

function AuthView({ qr, state, error, onRefresh }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0d0f12] px-6">
      <div className="w-full max-w-md border border-[#2E2E2E] bg-[#141414] p-10">
        <p className="text-xs uppercase tracking-[0.3em] text-[#737373]">Superagente</p>
        <h1 className="mt-3 text-2xl font-light text-[#F2F2F2]">Conectar WhatsApp</h1>
        <p className="mt-2 text-sm text-[#737373]">
          Escanea el código QR con tu teléfono para vincular la instancia local.
        </p>

        <div className="mt-8 flex min-h-[280px] items-center justify-center border border-[#2E2E2E] bg-[#0D0D0D]">
          {qr ? (
            <img
              src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`}
              alt="Código QR de WhatsApp"
              className="h-64 w-64 object-contain"
            />
          ) : (
            <p className="text-sm text-[#737373]">Generando QR...</p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-[#2E2E2E] pt-4">
          <span className="text-xs uppercase tracking-widest text-[#737373]">
            Estado: {state || 'connecting'}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="border border-[#2E2E2E] bg-[#BFBFBF] px-4 py-2 text-xs uppercase tracking-widest text-[#000000]"
          >
            Actualizar
          </button>
        </div>

        {error && (
          <p className="mt-4 border border-[#2E2E2E] px-3 py-2 text-xs text-[#737373]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ChatList({ chats, selectedId, onSelect, onNotificationRead, activeTab, onTabChange, onSelectStatus, onSelectCall }) {
  const [query, setQuery] = useState('');
  const [broadcasts, setBroadcasts] = useState([]);
  const [calls, setCalls] = useState([]);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [selectedStatusId, setSelectedStatusId] = useState(null);
  const [selectedCallId, setSelectedCallId] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((chat) => {
      const name = (chat.nombre || chat.name || chat.pushName || '').toLowerCase();
      return name.includes(q) || String(chat.id || '').toLowerCase().includes(q);
    });
  }, [chats, query]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aTime = new Date(a.updated_at || 0).getTime();
      const bTime = new Date(b.updated_at || 0).getTime();
      return bTime - aTime;
    });
  }, [filtered]);

  const lastMessage = useCallback((chat) => {
    if (!chat.ultimo_mensaje) return 'Sin mensajes';
    const text = String(chat.ultimo_mensaje).trim();
    return text.length > 40 ? text.slice(0, 40) + '...' : text;
  }, []);

  useEffect(() => {
    if (activeTab === 'status') {
      setLoadingStatus(true);
      setSelectedStatusId(null);
      api.broadcasts().then((data) => {
        const arr = Array.isArray(data) ? data.filter((m) => m && m.texto) : [];
        const unique = Array.from(new Map(arr.map((m) => [m.id || m.chat_id, m])).values());
        setBroadcasts(unique.slice(0, 50));
      }).catch(() => {})
      .finally(() => setLoadingStatus(false));
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'calls') {
      setLoadingCalls(true);
      setSelectedCallId(null);
      Promise.all([
        api.callHistory(selectedChatId || '').catch(() => []),
        api.chats().catch(() => []),
      ]).then(([history, chatList]) => {
        const chatMap = new Map((Array.isArray(chatList) ? chatList : []).map((c) => [c.id, c]));
        const items = (Array.isArray(history) ? history : []).map((call) => {
          const isMissed = String(call.status || '').toLowerCase() === 'missed';
          return { ...call, chatName: chatMap.get(call.remoteJid)?.nombre || formatJid(call.remoteJid || ''), isMissed };
        });
        setCalls(items.slice(0, 100));
      }).finally(() => setLoadingCalls(false));
    }
  }, [activeTab]);

  const callIcon = (call) => {
    if (call.isMissed) return '📵';
    if (String(call.type || '').toLowerCase() === 'outgoing') return '📤';
    return '📥';
  };

  return (
    <aside className="flex h-full w-[35%] min-w-[320px] flex-col border-r border-[#2E2E2E] bg-[#111b21]">
      <header className="wa-chat-list-header border-b border-[#2a3942] px-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: COLORS.green }}>
              <span className="text-sm font-medium text-white">LYN</span>
            </div>
            <span className="text-base font-medium" style={{ color: COLORS.textPrimary }}>
              {activeTab === 'chats' ? 'Chats' : activeTab === 'status' ? 'Estados' : 'Llamadas'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]" style={{ color: COLORS.textSecondary }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
          </div>
        </div>

        <div className="mt-2 flex gap-2 border-b border-[#2a3942]">
          {[
            { key: 'chats', label: 'Chats' },
            { key: 'status', label: 'Estados' },
            { key: 'calls', label: 'Llamadas' },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange?.(tab.key)}
              className="flex-1 pb-2 text-xs uppercase tracking-widest transition-colors"
              style={{ color: activeTab === tab.key ? COLORS.textPrimary : COLORS.textSecondary, borderBottom: activeTab === tab.key ? '2px solid ' + COLORS.green : '2px solid transparent' }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: COLORS.inputBg }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: COLORS.textSecondary }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={activeTab === 'chats' ? 'Buscar o empezar una conversación' : activeTab === 'status' ? 'Buscar estados...' : 'Buscar llamadas...'}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#8696a0]"
              style={{ color: COLORS.textPrimary }}
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'chats' && (
          <>
            {chats.length === 0 && sorted.length === 0 && (
              <div className="px-4 py-8 text-center text-sm" style={{ color: COLORS.textSecondary }}>
                Sin conversaciones aún.
              </div>
            )}
            {sorted.map((chat) => {
              const active = chat.id === selectedId;
              const displayName = chatDisplayName(chat);
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => {
                    onNotificationRead?.(chat.id);
                    onSelect(chat.id);
                  }}
                  className="wa-sidebar-item flex w-full items-center gap-3 border-b border-[#2a3942] px-3 py-3 text-left transition-colors hover:bg-[#202c33]"
                  style={{ backgroundColor: active ? '#202c33' : 'transparent' }}
                >
                    <div className="relative shrink-0">
                      <Avatar name={displayName} size={48} imageUrl={chat.profile_picture_url || chat.profilePicUrl} />
                      {String(chat.id || '').includes('@g.us') && (
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#202c33] text-[9px]" style={{ color: COLORS.textSecondary }}>👥</span>
                      )}
                      {(chat.pinned || chat.isPinned) && (
                        <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#00a884] text-[9px] text-white">📌</span>
                      )}
                      {(chat.muted || chat.isMuted) && (
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#202c33] text-[9px]" style={{ color: COLORS.textSecondary }}>🔕</span>
                      )}
                    </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium" style={{ color: COLORS.textPrimary }}>{displayName}</p>
                      <span className="shrink-0 text-[11px]" style={{ color: COLORS.textSecondary }}>
                        {formatTime(chat.updated_at)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs" style={{ color: COLORS.textSecondary }}>
                      {lastMessage(chat)}
                    </p>
                  </div>
                </button>
              );
            })}
          </>
        )}

        {activeTab === 'status' && (
          <div className="flex flex-col">
            {loadingStatus && <div className="px-4 py-3 text-xs" style={{ color: COLORS.textSecondary }}>Cargando estados...</div>}
            {!loadingStatus && broadcasts.length === 0 && (
              <div className="px-4 py-8 text-center text-xs" style={{ color: COLORS.textSecondary }}>
                <p className="mb-2 text-sm" style={{ color: COLORS.textPrimary }}>Estados</p>
                <p>No hay estados publicados por tus contactos aún.</p>
                <p className="mt-2">Los estados de broadcast aparecerán aquí cuando Evolution API los envíe.</p>
              </div>
            )}
            {broadcasts.map((status) => {
              const displayName = status.remitente || formatJid(status.chat_id || '');
              const isSelected = selectedStatusId === (status.id || status.chat_id);
              return (
                <button key={status.id || status.chat_id} type="button" onClick={() => { setSelectedStatusId(status.id || status.chat_id); onSelectStatus?.(status); }} className={`flex w-full items-center gap-3 border-b border-[#2a3942] px-3 py-3 text-left transition-colors ${isSelected ? 'bg-[#202c33]' : 'hover:bg-[#202c33]'}`}>
                  <div className="relative shrink-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#00a884] text-xs text-white" style={{ backgroundColor: COLORS.green }}>
                      <span>{getInitials(displayName)}</span>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: COLORS.textPrimary }}>{displayName}</p>
                    <p className="truncate text-xs" style={{ color: COLORS.textSecondary }}>{status.texto || 'Estado'}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {activeTab === 'calls' && (
          <div className="flex flex-col">
            {loadingCalls && <div className="px-4 py-3 text-xs" style={{ color: COLORS.textSecondary }}>Cargando llamadas...</div>}
            {!loadingCalls && calls.length === 0 && (
              <div className="px-4 py-8 text-center text-xs" style={{ color: COLORS.textSecondary }}>
                <p className="mb-2 text-sm" style={{ color: COLORS.textPrimary }}>Llamadas</p>
                <p>No hay llamadas registradas.</p>
              </div>
            )}
            {calls.map((call, idx) => {
              const callKey = call.id || call.callId || `${call.remoteJid}-${idx}`;
              const isSelected = selectedCallId === callKey;
              return (
                <button key={callKey} type="button" onClick={() => { setSelectedCallId(callKey); onSelectCall?.(call); }} className={`flex w-full items-center gap-3 border-b border-[#2a3942] px-3 py-3 text-left transition-colors ${isSelected ? 'bg-[#202c33]' : 'hover:bg-[#202c33]'}`}>
                  <div className="flex h-10 w-10 items-center justify-center rounded-full text-lg" style={{ color: call.isMissed ? COLORS.red : COLORS.textPrimary }}>
                    {callIcon(call)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: COLORS.textPrimary }}>{call.chatName || formatJid(call.remoteJid || '')}</p>
                    <p className="truncate text-xs" style={{ color: call.isMissed ? COLORS.red : COLORS.textSecondary }}>
                      {call.isMissed ? 'Llamada perdida' : call.type === 'outgoing' ? 'Llamada saliente' : 'Llamada entrante'}
                      {call.timestamp ? ` · ${new Date(call.timestamp).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function ChatHeader({ chat, onRename, onDisconnect, onTestNotification, onAuthStateChange, onOpenContactInfo, onBack }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chatDisplayName(chat));
  const [showProfile, setShowProfile] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profilePicture, setProfilePicture] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    setName(chatDisplayName(chat));
  }, [chat]);

  const loadProfile = async () => {
    if (!chat?.id || profileLoading) return;
    setProfileLoading(true);
    try {
      const [profileData, pictureData] = await Promise.all([
        api.profileShow(chat.id).catch(() => null),
        api.profilePictureUrl(chat.id).catch(() => null),
      ]);
      setProfile(profileData || null);
      const rawPicture = pictureData?.profilePictureUrl || pictureData?.url || null;
      const pictureUrl = rawPicture && (rawPicture.includes('mmg.whatsapp.net') || rawPicture.includes('a.whatsapp.net')) ? null : rawPicture;
      setProfilePicture(pictureUrl);
    } catch {
      // ignore
    } finally {
      setProfileLoading(false);
    }
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setEditing(false);
    try {
      await onRename?.(chat?.id, trimmed);
    } catch {
      // ignore
    }
  };

  const handleDisconnect = () => {
    onAuthStateChange?.({ authorized: false, connected: false });
    onDisconnect?.();
    setEditing(false);
  };

  const handleTestNotification = () => {
    try {
      onTestNotification?.(chat?.id || 'test-chat', {
        id: `test-msg-${Date.now()}`,
        texto: 'Mensaje de prueba desde test',
        classification: { rol: 'test', urgencia: 'alta' },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[test] sendBrowserNotification error', err);
    }
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-[#2a3942] px-4" style={{ backgroundColor: COLORS.sidebarHeader }}>
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button" onClick={onBack} title="Volver" className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33] md:hidden" style={{ color: COLORS.textSecondary }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
        )}
        <button type="button" onClick={() => { setShowProfile((s) => !s); if (!showProfile) loadProfile(); }} className="relative">
          <Avatar name={chatDisplayName(chat)} size={40} imageUrl={chat.profile_picture_url || chat.profilePicUrl || profilePicture} />
          {showProfile && !String(chat?.id || '').includes('@g.us') && (
            <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-lg border border-[#2a3942] p-4 shadow-lg" style={{ backgroundColor: COLORS.sidebarHeader }}>
              <div className="flex items-center justify-between border-b border-[#2a3942] pb-3">
                <p className="text-xs font-medium uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Perfil</p>
                <span onClick={() => setShowProfile(false)} className="cursor-pointer text-[10px] uppercase tracking-widest hover:opacity-80" style={{ color: COLORS.textSecondary }}>Cerrar</span>
              </div>
              {profileLoading && <p className="mt-3 text-xs" style={{ color: COLORS.textSecondary }}>Cargando...</p>}
              {!profileLoading && (
                <div className="mt-4">
                  {profilePicture && (
                    <img src={profilePicture} alt="profile" className="mb-3 h-20 w-20 rounded-full border border-[#2a3942] object-cover" />
                  )}
                  <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{profile?.name || chatDisplayName(chat)}</p>
                  <p className="text-xs" style={{ color: COLORS.textSecondary }}>{profile?.status || ''}</p>
                  {profile?.about && <p className="mt-2 text-xs" style={{ color: COLORS.textSecondary }}>{profile.about}</p>}
                </div>
              )}
            </div>
          )}
        </button>
        <div className="flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setEditing(false);
                }}
                className="h-8 flex-1 rounded border border-[#3b4a52] bg-[#2a3942] px-2 text-sm outline-none"
                style={{ color: COLORS.textPrimary }}
                autoFocus
              />
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="truncate text-left text-sm font-medium hover:opacity-80"
                style={{ color: COLORS.textPrimary }}
              >
                {chatDisplayName(chat)}
              </button>
              <p className="text-xs" style={{ color: COLORS.textSecondary }}>{chatDisplayName(chat) ? 'En línea' : ''}</p>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onOpenContactInfo && (
          <button
            type="button"
            onClick={onOpenContactInfo}
            title="Información del contacto"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]"
            style={{ color: COLORS.textSecondary }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </button>
        )}
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]"
          style={{ color: COLORS.textSecondary }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
        <button
          type="button"
          onClick={handleTestNotification}
          className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]"
          style={{ color: COLORS.textSecondary }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button
          type="button"
          onClick={handleDisconnect}
          className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]"
          style={{ color: COLORS.red }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="9" x2="5" y2="9"/><line x1="19" y1="15" x2="5" y2="15"/></svg>
        </button>
      </div>
    </header>
  );
}

const mediaCache = new Map();

function MessageBubble({ msg }) {
  const isMe = Boolean(msg.enviado_por_mi);
  const showSender = !isMe && msg.remitente;
  const time = formatTime(msg.timestamp);

  const mediaSrc = useMemo(() => {
    if (!msg.media?.url) return undefined;
    const u = String(msg.media.url);
    if (u.includes('mmg.whatsapp.net') || u.includes('a.whatsapp.net')) return undefined;
    return `/api/media/message/${encodeURIComponent(msg.id)}/base64`;
  }, [msg.id, msg.media?.url]);

  const labelType = useMemo(() => {
    if (!msg.tipo) return '';
    return msg.tipo === 'ptt' ? 'audio' : msg.tipo;
  }, [msg.tipo]);

  const [mediaData, setMediaData] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

  useEffect(() => {
    if (!showMenu && !showReactions) return;
    const handleClick = () => { setShowMenu(false); setShowReactions(false); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [showMenu, showReactions]);

  useEffect(() => {
    if (!mediaSrc) return;
    if (mediaCache.has(mediaSrc)) {
      setMediaData(mediaCache.get(mediaSrc));
      return;
    }
    let cancelled = false;
    fetch(mediaSrc)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`media fetch failed: ${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 200) : ''}`);
        }
        const data = await res.json();
        if (!cancelled) {
          mediaCache.set(mediaSrc, data);
          setMediaData(data);
        }
      })
      .catch((err) => {
        if (!cancelled) setMediaData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaSrc, msg.id]);

  const finalSrc = useMemo(() => {
    if (mediaData?.base64) return mediaData.base64;
    if (msg.media?.base64) return msg.media.base64;
    if (msg.media?.url) {
      const u = String(msg.media.url);
      if (u.startsWith('http://') || u.startsWith('https://')) {
        if (u.includes('mmg.whatsapp.net') || u.includes('a.whatsapp.net')) return null;
        return u;
      }
    }
    return null;
  }, [mediaData, msg.media]);
  const status = typeof msg.estado === 'string' ? msg.estado.toLowerCase() : '';
  const statusIcon = useMemo(() => {
    if (!isMe) return null;
    if (status === 'leido') return <span style={{ color: COLORS.checkBlue }}>✓✓</span>;
    if (status === 'entregado') return <span style={{ color: COLORS.checkGray }}>✓✓</span>;
    if (status === 'enviado') return <span style={{ color: COLORS.checkGray }}>✓</span>;
    if (status === 'fallido') return <span style={{ color: COLORS.red }}>!</span>;
    return <span style={{ color: COLORS.checkGray }}>✓</span>;
  }, [isMe, status]);

  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className="wa-message-enter group relative max-w-[65%] rounded-lg px-1.5 py-1 text-sm leading-relaxed shadow-sm"
        style={{
          backgroundColor: isMe ? COLORS.outgoingBubble : COLORS.incomingBubble,
          color: COLORS.textPrimary,
          borderRadius: isMe ? '8px 8px 0 8px' : '8px 8px 8px 0',
        }}
        onContextMenu={(e) => { e.preventDefault(); setShowMenu((s) => !s); setShowReactions(false); }}
      >
        {showSender && (
          <p className="mb-1 text-xs font-semibold" style={{ color: '#4a7c59' }}>{msg.remitente}</p>
        )}

        {msg.tipo === 'text' && (
          <p className="whitespace-pre-wrap break-words">{msg.texto}</p>
        )}

        {msg.tipo === 'image' && finalSrc && (
          <img
            src={finalSrc}
            alt={msg.texto || 'imagen'}
            className="mb-1 max-h-64 w-full rounded object-contain"
          />
        )}

        {msg.tipo === 'video' && finalSrc && (
          <video
            src={finalSrc}
            controls
            preload="metadata"
            className="mt-2 max-h-64 rounded"
          />
        )}

        {(msg.tipo === 'audio' || msg.tipo === 'ptt') && finalSrc && (
          <audio
            src={finalSrc}
            controls
            preload="metadata"
            className="mt-2"
          />
        )}

        {msg.tipo === 'sticker' && finalSrc && (
          <img
            src={finalSrc}
            alt="sticker"
            className="mt-2 h-40 w-auto rounded"
          />
        )}

        {msg.tipo === 'document' && finalSrc && (
          <a
            href={finalSrc}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
            style={{ color: COLORS.textPrimary }}
          >
            {msg.texto || 'Ver documento'}
          </a>
        )}

        {msg.tipo !== 'text' && msg.tipo !== 'document' && msg.texto?.trim() && (
          <p className="mt-1 whitespace-pre-wrap break-words">{msg.texto}</p>
        )}

        <div className="mt-1 flex items-center justify-end gap-1 text-[10px]" style={{ color: COLORS.textSecondary }}>
          <span>{time}</span>
          {isMe && statusIcon}
        </div>

        {Array.isArray(msg.reacciones) && msg.reacciones.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {msg.reacciones.filter((r, i, arr) => arr.findIndex((x) => (x.emoji || x.reaction || x) === (r.emoji || r.reaction || r)) === i).map((r, idx) => {
              const emoji = r.emoji || r.reaction || String(r);
              const count = (r.count || msg.reacciones.filter((x) => (x.emoji || x.reaction || x) === emoji).length);
              return count > 0 ? (
                <span key={idx} className="rounded-full border border-[#2a3942] bg-[#182229] px-1.5 py-0.5 text-[10px]" style={{ color: COLORS.textPrimary }}>
                  {emoji} {count > 1 ? count : ''}
                </span>
              ) : null;
            })}
          </div>
        )}

        <div className="absolute -right-9 top-0 hidden h-full w-6 flex-col items-center justify-center group-hover:flex">
          <button type="button" onClick={() => setShowMenu((s) => !s)} className="rounded-full p-1 hover:bg-[#2a3942]" style={{ color: COLORS.textSecondary }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>
          </button>
        </div>

        {showMenu && (
          <div className="absolute right-0 top-0 z-20 flex w-40 flex-col rounded-lg border border-[#2a3942] bg-[#202c33] shadow-lg">
            <button type="button" onClick={() => { navigator.clipboard.writeText(msg.texto || ''); setShowMenu(false); }} className="px-3 py-2 text-left text-xs hover:bg-[#2a3942]" style={{ color: COLORS.textPrimary }}>Copiar</button>
            <button type="button" onClick={() => { alert(`ID: ${msg.id}\nTipo: ${msg.tipo}\nFecha: ${new Date(msg.timestamp).toLocaleString()}`); setShowMenu(false); }} className="px-3 py-2 text-left text-xs hover:bg-[#2a3942]" style={{ color: COLORS.textPrimary }}>Info</button>
            <button type="button" onClick={() => { setShowMenu(false); setShowReactions((s) => !s); }} className="px-3 py-2 text-left text-xs hover:bg-[#2a3942]" style={{ color: COLORS.textPrimary }}>Reaccionar</button>
            <button type="button" onClick={async () => { await api.deleteMessage(msg.id, msg.chat_id, msg.enviado_por_mi, null); setShowMenu(false); }} className="px-3 py-2 text-left text-xs text-red-400 hover:bg-[#2a3942]">Eliminar</button>
          </div>
        )}

        {showReactions && (
          <div className="absolute -top-10 right-0 z-30 flex gap-1 rounded-full border border-[#2a3942] bg-[#202c33] p-1 shadow-lg">
            {REACTION_EMOJIS.map((emoji) => (
              <button key={emoji} type="button" onClick={async () => { await api.sendReaction({ key: { id: msg.id, remoteJid: msg.chat_id }, reaction: emoji }); setShowReactions(false); }} className="rounded-full p-1 text-sm hover:bg-[#2a3942]">
                {emoji}
              </button>
            ))}
            <button type="button" onClick={() => setShowReactions(false)} className="px-2 text-xs" style={{ color: COLORS.textSecondary }}>✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

function DateSeparator({ label }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-lg px-2 py-1 text-[11px] font-normal" style={{ backgroundColor: '#182229', color: COLORS.textSecondary }}>
        {label}
      </span>
    </div>
  );
}

function MessageTimeline({ mensajes }) {
  const timelineRef = useRef(null);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mensajes;
    return mensajes.filter((m) => (m.texto || '').toLowerCase().includes(q));
  }, [mensajes, query]);

  const grouped = useMemo(() => {
    const groups = [];
    let current = null;
    for (const msg of filtered) {
      const day = new Date(msg.timestamp).toDateString();
      if (!current || current.day !== day) {
        current = { day, messages: [] };
        groups.push(current);
      }
      current.messages.push(msg);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [filtered.length]);

  const inputRef = useRef(null);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      inputRef.current?.focus();
    }
  }, []);

  return (
    <div
      ref={timelineRef}
      className="flex-1 overflow-y-auto"
      style={{
        backgroundColor: COLORS.chatBg,
        backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0)',
        backgroundSize: '20px 20px',
      }}
    >
      <div className="mx-auto max-w-3xl px-8 py-6">
        {filtered.length === 0 && !query.trim() && (
          <div className="wa-empty-state flex h-full items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: '#1a2a33' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: COLORS.textSecondary }}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              </div>
              <p className="text-base font-light" style={{ color: COLORS.textPrimary }}>LYN Web</p>
              <p className="mt-1 text-xs" style={{ color: '#5e6d75' }}>Envía y recibe mensajes sin mantener el teléfono conectado.</p>
              <p className="mt-4 text-[11px]" style={{ color: '#5e6d75' }}>Usa LYN en hasta 4 dispositivos vinculados y 1 teléfono al mismo tiempo.</p>
            </div>
          </div>
        )}

        {query.trim() && (
          <div className="mb-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar mensajes..."
              className="h-9 w-full rounded-lg border px-3 text-xs outline-none"
              style={{ borderColor: COLORS.inputBorder, backgroundColor: COLORS.inputBg, color: COLORS.textPrimary }}
            />
          </div>
        )}
        {query.trim() && filtered.length === 0 && (
          <div className="py-10 text-center text-xs" style={{ color: COLORS.textSecondary }}>No hay mensajes que coincidan con la búsqueda.</div>
        )}
        {!query.trim() && filtered.length > 0 && (
          <div className="flex flex-col gap-1">
            {grouped.map((group, idx) => (
              <div key={group.day} className="flex flex-col gap-1">
                <DateSeparator label={formatDay(group.messages[0]?.timestamp)} />
                {group.messages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationSidebar({ open, history, onClear, onNotificationRead }) {
  const uniqueHistory = useMemo(() => {
    const seen = new Set();
    return history.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [history]);

  if (!open) return null;

  return (
    <aside className="hidden w-80 flex-col border-l border-[#2a3942] md:flex" style={{ backgroundColor: COLORS.sidebarBg }}>
      <div className="flex items-center justify-between border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
        <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>Notificaciones</p>
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] uppercase tracking-widest hover:opacity-80"
          style={{ color: COLORS.textSecondary }}
        >
          Limpiar
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {uniqueHistory.length === 0 ? (
          <p className="px-4 py-3 text-xs" style={{ color: COLORS.textSecondary }}>Sin notificaciones recientes.</p>
        ) : (
          uniqueHistory.map((item) => (
            <div
              key={item.id}
              className="border-b border-[#2a3942] px-4 py-3 transition-colors hover:bg-[#202c33]"
              onClick={() => onNotificationRead?.(item.chatId)}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium" style={{ color: COLORS.textPrimary }}>{item.chatName}</p>
                <span className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>{item.urgencia}</span>
              </div>
              <p className="mt-1 truncate text-xs" style={{ color: COLORS.textSecondary }}>{item.text}</p>
              <p className="mt-1 text-[10px]" style={{ color: COLORS.textSecondary }}>
                {item.timestamp ? new Date(item.timestamp).toLocaleString('es-ES') : ''}
              </p>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function DraftPanel({ draft, onDraftChange, onSend, sending, disabled, chatId, onAction }) {
  const [showActions, setShowActions] = useState(false);
  const inputRef = useRef(null);

  const attachActions = [
    { key: 'image', icon: '🖼️', title: 'Imagen o video' },
    { key: 'document', icon: '📄', title: 'Documento' },
    { key: 'audio', icon: '🎵', title: 'Audio' },
    { key: 'sticker', icon: '😀', title: 'Sticker' },
    { key: 'ptv', icon: '🎬', title: 'Video corto' },
    { key: 'location', icon: '📍', title: 'Ubicación' },
    { key: 'contact', icon: '👤', title: 'Contacto' },
    { key: 'poll', icon: '📊', title: 'Encuesta' },
  ];

  const chatActions = [
    { key: 'list', icon: '📋', title: 'Lista interactiva' },
    { key: 'buttons', icon: '🔘', title: 'Botones' },
    { key: 'template', icon: '📝', title: 'Plantilla' },
    { key: 'status', icon: '📢', title: 'Estado' },
    { key: 'reaction', icon: '👍', title: 'Reaccionar' },
  ];

  const editActions = [
    { key: 'edit-message', icon: '✏️', title: 'Editar último' },
    { key: 'delete-message', icon: '🗑️', title: 'Borrar último' },
  ];

  const chatOps = [
    { key: 'chat-mute', icon: '🔕', title: 'Silenciar' },
    { key: 'chat-unmute', icon: '🔔', title: 'Desilenciar' },
    { key: 'chat-pin', icon: '📌', title: 'Fijar' },
    { key: 'chat-unpin', icon: '📍', title: 'Desfijar' },
    { key: 'chat-archive', icon: '📁', title: 'Archivar' },
    { key: 'chat-clear', icon: '🧹', title: 'Limpiar chat' },
    { key: 'chat-delete', icon: '❌', title: 'Eliminar chat' },
  ];

  const renderGroup = (label, items) => (
    <div className="mb-3">
      {label && <p className="mb-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>{label}</p>}
      <div className="grid grid-cols-4 gap-2">
        {items.map((a) => (
          <button key={a.key} type="button" title={a.title} onClick={() => { handleAction(a.key); }} className="flex flex-col items-center gap-1 rounded-lg border border-[#2a3942] bg-[#0b141a] p-2 transition-colors hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>
            <span className="text-lg">{a.icon}</span>
            <span className="text-[9px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>{a.title}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const handleAction = (key) => {
    if (onAction) onAction(key);
  };

  return (
    <footer className="wa-draft-bar border-t border-[#2a3942] px-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
      {showActions && (
        <div className="mb-2 rounded-lg border border-[#2a3942] bg-[#0b141a] p-3">
          {renderGroup('Adjuntos', attachActions)}
          {renderGroup('Chat', chatActions)}
          {renderGroup('Mensaje', editActions)}
          {renderGroup('Operaciones', chatOps)}
          <button type="button" title="Cerrar" onClick={() => setShowActions(false)} className="mt-2 w-full rounded-full border border-[#ef4444] bg-[#2a3942] py-1 text-[10px] uppercase tracking-widest transition-colors hover:bg-[#3b4a52]" style={{ color: COLORS.red }}>
            Cerrar
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-[#2a3942] bg-[#2a3942] px-3 py-2">
        <button
          type="button"
          onClick={() => setShowActions((s) => !s)}
          disabled={disabled}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[#3b4a52] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: COLORS.textSecondary }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          disabled={disabled}
          placeholder="Escribe un mensaje..."
          rows={1}
          className="h-10 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-[#8696a0] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ color: COLORS.textPrimary }}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || sending || !draft.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[#005c4b] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: COLORS.green, color: COLORS.white }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </footer>
  );
}

function AiPanel({
  selectedChatId,
  mensajes,
  draft,
  onClassification,
  onAutoReply,
  onSummary,
  onNotify,
  onSendReply,
  classification,
  autoReply,
  summary,
}) {
  const [loading, setLoading] = useState({ classify: false, reply: false, summary: false, notify: false });
  const [specialists, setSpecialists] = useState([]);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/specialists`)
      .then(async (res) => { if (!res.ok) throw new Error(); const data = await res.json(); if (!cancelled) setSpecialists(Array.isArray(data) ? data : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const lastMessage = useMemo(() => {
    if (!Array.isArray(mensajes) || !mensajes.length) return draft || '';
    return mensajes[mensajes.length - 1].texto || draft || '';
  }, [mensajes, draft]);

  const aiText = useMemo(() => {
    const parts = [];
    if (autoReply?.respuesta) parts.push(autoReply.respuesta);
    if (summary?.resumen) parts.push(summary.resumen);
    return parts.join('\n\n');
  }, [autoReply, summary]);

  const handleClassify = async () => {
    if (!selectedChatId) return;
    setLoading((s) => ({ ...s, classify: true }));
    try {
      const res = await fetch(`${API_BASE}/api/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: lastMessage }),
      });
      if (!res.ok) throw new Error('Error al clasificar');
      await onClassification(await res.json());
    } catch (error) {
      console.error('[dashboard] classify error:', error);
    } finally {
      setLoading((s) => ({ ...s, classify: false }));
    }
  };

  const handleAutoReply = async () => {
    if (!selectedChatId || !lastMessage) return;
    setLoading((s) => ({ ...s, reply: true }));
    try {
      const res = await fetch(`${API_BASE}/api/ai/auto-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: selectedChatId, mensaje: lastMessage }),
      });
      if (!res.ok) throw new Error('Error al generar respuesta');
      const data = await res.json();
      await onAutoReply(data);
      const replyText = data?.respuesta || data?.message || data?.text || '';
      if (replyText && typeof onSendReply === 'function') {
        await onSendReply(replyText);
      }
    } catch (error) {
      console.error('[dashboard] auto-reply error:', error);
    } finally {
      setLoading((s) => ({ ...s, reply: false }));
    }
  };

  const handleSummary = async () => {
    if (!selectedChatId) return;
    setLoading((s) => ({ ...s, summary: true }));
    try {
      const res = await fetch(`${API_BASE}/api/resumen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: selectedChatId, dias: 7 }),
      });
      if (!res.ok) throw new Error('Error al resumir');
      await onSummary(await res.json());
    } catch (error) {
      console.error('[dashboard] summary error:', error);
    } finally {
      setLoading((s) => ({ ...s, summary: false }));
    }
  };

  const handleNotify = async () => {
    if (!selectedChatId) return;
    setLoading((s) => ({ ...s, notify: true }));
    try {
      const res = await fetch(`${API_BASE}/api/notify-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rol: classification?.rol || 'General',
          mensaje: lastMessage,
        }),
      });
      if (!res.ok) throw new Error('Error al notificar');
      await onNotify(await res.json());
    } catch (error) {
      console.error('[dashboard] notify error:', error);
    } finally {
      setLoading((s) => ({ ...s, notify: false }));
    }
  };

  const copyToClipboard = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <aside className="hidden w-80 flex-col border-l border-[#2a3942] lg:flex" style={{ backgroundColor: COLORS.sidebarBg }}>
      <div className="border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
        <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>IA</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <p className="text-xs font-medium mb-2" style={{ color: COLORS.textSecondary }}>Clasificación actual</p>
          {classification ? (
            <div className="rounded-lg border border-[#2a3942] p-3" style={{ backgroundColor: '#0b141a' }}>
              <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{classification.rol || 'General'}</p>
              <p className="text-xs mt-1" style={{ color: COLORS.textSecondary }}>Confianza: {Math.round((classification.confianza || 0) * 100)}%</p>
              <p className="text-xs mt-1" style={{ color: COLORS.textSecondary }}>Urgencia: {classification.urgencia || 'media'}</p>
            </div>
          ) : (
            <p className="text-xs" style={{ color: COLORS.textSecondary }}>Sin clasificación aún.</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleClassify}
            disabled={!selectedChatId || loading.classify}
            className="rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-2 text-xs transition-colors hover:bg-[#3b4a52] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: COLORS.textPrimary }}
          >
            {loading.classify ? 'Clasificando...' : 'Clasificar'}
          </button>
          <button
            type="button"
            onClick={handleAutoReply}
            disabled={!selectedChatId || !lastMessage || loading.reply}
            className="rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-2 text-xs transition-colors hover:bg-[#3b4a52] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: COLORS.textPrimary }}
          >
            {loading.reply ? 'Respondiendo...' : 'Auto-respuesta'}
          </button>
          <button
            type="button"
            onClick={handleSummary}
            disabled={!selectedChatId || loading.summary}
            className="rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-2 text-xs transition-colors hover:bg-[#3b4a52] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: COLORS.textPrimary }}
          >
            {loading.summary ? 'Resumiendo...' : 'Resumir'}
          </button>
          <button
            type="button"
            onClick={handleNotify}
            disabled={!selectedChatId || !classification?.rol || loading.notify}
            className="rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-2 text-xs transition-colors hover:bg-[#3b4a52] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: COLORS.textPrimary }}
          >
            {loading.notify ? 'Notificando...' : 'Notificar rol'}
          </button>
        </div>

        {specialists.length > 0 && (
          <div className="mt-6">
            <p className="text-xs font-medium mb-2" style={{ color: COLORS.textSecondary }}>Especialistas</p>
            <div className="flex flex-col gap-2">
              {specialists.map((spec) => (
                <div key={spec.id} className="rounded-lg border border-[#2a3942] p-3" style={{ backgroundColor: '#0b141a' }}>
                  <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{spec.nombre}</p>
                  <p className="text-xs" style={{ color: COLORS.textSecondary }}>{spec.rol}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {aiText && (
          <div className="mt-6">
            <div className="flex items-center justify-between border-b border-[#2a3942] px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Respuesta IA</p>
              <button
                type="button"
                onClick={() => copyToClipboard(aiText, 'ai')}
                className="text-[10px] uppercase tracking-widest hover:opacity-80"
                style={{ color: COLORS.textSecondary }}
              >
                {copied === 'ai' ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto px-3 py-2">
              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed" style={{ color: COLORS.textPrimary }}>{aiText}</pre>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ContactInfoPanel({ chat, open, onClose, onAction, className }) {
  if (!open || !chat) return null;

  const displayName = chatDisplayName(chat);
  const isGroup = String(chat.id || '').includes('@g.us');
  const phone = isGroup ? null : String(chat.id || '').replace(/[^0-9]/g, '');
  const about = chat.about || chat.pushName || '';
  const lastSeen = chat.lastSeen || (chat.updated_at ? new Date(chat.updated_at).toLocaleString('es-ES') : '—');
  const muted = chat.muted || chat.isMuted || false;
  const pinned = chat.pinned || chat.isPinned || false;
  const archived = chat.archived || chat.isArchived || false;

  const handleActionClick = (key) => {
    if (typeof window !== 'undefined') {
      if (onAction) onAction(key);
    }
  };

  return (
    <aside className={`${className || ''} w-80 flex-col border-l border-[#2a3942]`} style={{ backgroundColor: COLORS.sidebarBg }}>
      <div className="flex items-center justify-between border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
        <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>Datos de contacto</p>
        <button type="button" onClick={onClose} className="text-[10px] uppercase tracking-widest hover:opacity-80" style={{ color: COLORS.textSecondary }}>Cerrar</button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-3">
          <Avatar name={displayName} size={96} imageUrl={chat.profile_picture_url || chat.profilePicUrl} />
          <p className="text-base font-medium" style={{ color: COLORS.textPrimary }}>{displayName}</p>
          <p className="text-xs" style={{ color: COLORS.textSecondary }}>{about || formatJid(chat.id || '')}</p>
        </div>

        <div className="mt-6 space-y-3">
          <div className="rounded-lg border border-[#2a3942] p-3" style={{ backgroundColor: '#0b141a' }}>
            <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: COLORS.textSecondary }}>Información</p>
            <p className="text-sm" style={{ color: COLORS.textPrimary }}>{isGroup ? 'Grupo' : 'Contacto individual'}</p>
            {!isGroup && phone && <p className="text-xs mt-1" style={{ color: COLORS.textSecondary }}>Número: {phone}</p>}
            <p className="text-xs mt-1" style={{ color: COLORS.textSecondary }}>Última vez: {lastSeen}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pinned && <span className="rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-2 py-0.5 text-[10px]" style={{ color: COLORS.textSecondary }}>Fijado</span>}
              {muted && <span className="rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-2 py-0.5 text-[10px]" style={{ color: COLORS.textSecondary }}>Silenciado</span>}
              {archived && <span className="rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-2 py-0.5 text-[10px]" style={{ color: COLORS.textSecondary }}>Archivado</span>}
            </div>
          </div>

          <div className="rounded-lg border border-[#2a3942] p-3" style={{ backgroundColor: '#0b141a' }}>
            <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: COLORS.textSecondary }}>Acciones</p>
            <div className="grid grid-cols-2 gap-2">
              {!isGroup && (
                <button type="button" onClick={() => handleActionClick('call')} className="rounded border border-[#2a3942] px-2 py-1 text-xs hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>📞 Llamar</button>
              )}
              <button type="button" onClick={() => handleActionClick('profile-picture')} className="rounded border border-[#2a3942] px-2 py-1 text-xs hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>🖼️ Foto perfil</button>
              <button type="button" onClick={() => handleActionClick('chat-mute')} className="rounded border border-[#2a3942] px-2 py-1 text-xs hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>{muted ? '🔔 Desilenciar' : '🔕 Silenciar'}</button>
              <button type="button" onClick={() => handleActionClick('chat-pin')} className="rounded border border-[#2a3942] px-2 py-1 text-xs hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>{pinned ? '📍 Desfijar' : '📌 Fijar'}</button>
              <button type="button" onClick={() => handleActionClick('chat-archive')} className="rounded border border-[#2a3942] px-2 py-1 text-xs hover:bg-[#202c33]" style={{ color: COLORS.textPrimary }}>{archived ? '📤 Desarchivar' : '📁 Archivar'}</button>
              <button type="button" onClick={() => handleActionClick('chat-clear')} className="rounded border border-[#ef4444] bg-[#2a3942] px-2 py-1 text-xs hover:bg-[#3b4a52]" style={{ color: COLORS.red }}>🧹 Limpiar</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function DashboardView({
  chats,
  selectedChatId,
  onSelectChat,
  mensajes,
  draft,
  onDraftChange,
  onSend,
  sending,
  inputProps = {},
  onRenameChat,
  aiProps = {},
  notificationProps = {},
  onTestNotification,
  onAction,
  activeTab,
  onTabChange,
}) {
  const selectedChat = useMemo(
    () => (Array.isArray(chats) ? chats.find((chat) => chat.id === selectedChatId) : undefined),
    [chats, selectedChatId],
  );

  const [showContactInfo, setShowContactInfo] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedCall, setSelectedCall] = useState(null);

  useEffect(() => {
    setShowContactInfo(false);
    setSelectedStatus(null);
    setSelectedCall(null);
    if (selectedChatId) {
      setMobileChatOpen(true);
    }
  }, [selectedChatId]);

  const handleSelectChat = useCallback((chatId) => {
    onSelectChat?.(chatId);
    setMobileChatOpen(true);
  }, [onSelectChat]);

  const handleBack = useCallback(() => {
    setMobileChatOpen(false);
    setShowContactInfo(false);
  }, []);

  const handleRename = async (chatId, newName) => {
    try {
      const res = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(chatId)}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: newName }),
      });
      if (!res.ok) throw new Error('Error al renombrar');
      await onRenameChat?.(chatId, newName);
    } catch (error) {
      console.error(error);
    }
  };

  const handleDisconnect = () => {
    onTestNotification?.(selectedChatId || 'test-chat', {
      id: `test-msg-${Date.now()}`,
      texto: 'Mensaje de prueba desde test',
      classification: { rol: 'test', urgencia: 'alta' },
      timestamp: new Date().toISOString(),
    });
  };

  useEffect(() => {
    setShowContactInfo(false);
  }, [selectedChatId]);

  return (
    <div className="flex h-screen" style={{ backgroundColor: COLORS.sidebarBg }}>
      <div className={`${mobileChatOpen ? 'hidden' : 'flex'} md:flex w-full md:w-auto`}>
        <ChatList
          chats={chats}
          selectedId={selectedChatId}
          onSelect={handleSelectChat}
          onNotificationRead={notificationProps?.onNotificationRead}
          activeTab={activeTab}
          onTabChange={onTabChange}
          onSelectStatus={(status) => { setSelectedStatus(status); }}
          onSelectCall={(call) => { setSelectedCall(call); }}
        />
      </div>

      <main className="flex h-full flex-1 flex-col" style={{ backgroundColor: COLORS.chatBg }}>
        {activeTab === 'status' && selectedStatus ? (
          <div className="flex h-full flex-col">
            <header className="flex h-16 items-center justify-between border-b border-[#2a3942] px-4" style={{ backgroundColor: COLORS.sidebarHeader }}>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setSelectedStatus(null)} title="Volver" className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]" style={{ color: COLORS.textSecondary }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                </button>
                <div>
                  <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{selectedStatus.remitente || formatJid(selectedStatus.chat_id || '')}</p>
                  <p className="text-xs" style={{ color: COLORS.textSecondary }}>Estado</p>
                </div>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-[#00a884] text-2xl text-white" style={{ backgroundColor: COLORS.green }}>
                  {getInitials(selectedStatus.remitente || '?')}
                </div>
                <p className="text-base font-medium" style={{ color: COLORS.textPrimary }}>{selectedStatus.remitente || formatJid(selectedStatus.chat_id || '')}</p>
                <p className="text-sm" style={{ color: COLORS.textSecondary }}>{selectedStatus.texto || 'Estado sin texto'}</p>
                {selectedStatus.timestamp && (
                  <p className="text-xs" style={{ color: COLORS.textSecondary }}>{new Date(selectedStatus.timestamp).toLocaleString('es-ES')}</p>
                )}
                <div className="mt-6 flex gap-2">
                  <button type="button" onClick={() => { navigator.clipboard?.writeText(selectedStatus.texto || ''); }} className="rounded-full border border-[#2a3942] bg-[#2a3942] px-4 py-2 text-xs hover:bg-[#3b4a52]" style={{ color: COLORS.textPrimary }}>Copiar texto</button>
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === 'calls' && selectedCall ? (
          <div className="flex h-full flex-col">
            <header className="flex h-16 items-center justify-between border-b border-[#2a3942] px-4" style={{ backgroundColor: COLORS.sidebarHeader }}>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setSelectedCall(null)} title="Volver" className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[#202c33]" style={{ color: COLORS.textSecondary }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                </button>
                <div>
                  <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{selectedCall.chatName || formatJid(selectedCall.remoteJid || '')}</p>
                  <p className="text-xs" style={{ color: COLORS.textSecondary }}>Llamada</p>
                </div>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full text-2xl" style={{ color: selectedCall.isMissed ? COLORS.red : COLORS.textPrimary }}>
                    {callIcon(selectedCall)}
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{selectedCall.isMissed ? 'Llamada perdida' : selectedCall.type === 'outgoing' ? 'Llamada saliente' : 'Llamada entrante'}</p>
                    <p className="text-xs" style={{ color: COLORS.textSecondary }}>
                      {selectedCall.timestamp ? new Date(selectedCall.timestamp).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-[#2a3942] p-3" style={{ backgroundColor: '#0b141a' }}>
                  <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: COLORS.textSecondary }}>Detalles</p>
                  <p className="text-xs" style={{ color: COLORS.textPrimary }}>ID: {selectedCall.id || selectedCall.callId || '—'}</p>
                  <p className="text-xs mt-1" style={{ color: COLORS.textPrimary }}>Remoto: {formatJid(selectedCall.remoteJid || '')}</p>
                  <p className="text-xs mt-1" style={{ color: COLORS.textPrimary }}>Estado: {selectedCall.status || '—'}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { if (selectedCall.remoteJid) onSelectChat(selectedCall.remoteJid); }} className="rounded-full border border-[#00a884] bg-[#2a3942] px-4 py-2 text-xs hover:bg-[#3b4a52]" style={{ color: COLORS.textPrimary }}>Abrir chat</button>
                </div>
              </div>
            </div>
          </div>
        ) : selectedChat ? (
          <>
             <ChatHeader
               chat={selectedChat}
               onRename={handleRename}
               onDisconnect={handleDisconnect}
               onTestNotification={onTestNotification}
               onOpenContactInfo={() => setShowContactInfo(true)}
               onBack={handleBack}
             />

             <MessageTimeline mensajes={mensajes} />

             <DraftPanel
               draft={draft}
               onDraftChange={onDraftChange}
               onSend={onSend}
               sending={sending}
               disabled={!selectedChatId}
               chatId={selectedChatId}
               onAction={onAction}
             />
          </>
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full" style={{ backgroundColor: '#202c33' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: COLORS.textSecondary }}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            </div>
            <p className="mt-4 text-lg font-light" style={{ color: COLORS.textPrimary }}>WhatsApp Web</p>
            <p className="mt-2 text-sm" style={{ color: COLORS.textSecondary }}>Envía y recibe mensajes sin mantener el teléfono conectado.</p>
            <p className="mt-6 text-xs" style={{ color: COLORS.textSecondary }}>Usa WhatsApp en hasta 4 dispositivos vinculados y 1 teléfono al mismo tiempo.</p>
          </div>
        )}
      </main>

      <div className="hidden lg:flex w-80 flex-col border-l border-[#2a3942]" style={{ backgroundColor: COLORS.sidebarBg }}>
        <AiPanel
          selectedChatId={selectedChatId}
          mensajes={mensajes}
          draft={draft}
          classification={aiProps.classification}
          autoReply={aiProps.autoReply}
          summary={aiProps.summary}
          onClassification={aiProps.onClassification}
          onAutoReply={aiProps.onAutoReply}
          onSummary={aiProps.onSummary}
          onNotify={aiProps.onNotify}
          onSendReply={aiProps.onSendReply}
        />
      </div>

      <ContactInfoPanel
        chat={selectedChat}
        open={showContactInfo}
        onClose={() => setShowContactInfo(false)}
        onAction={(key) => onAction?.(key)}
        className="hidden md:flex"
      />
    </div>
  );
}

function UrgencyPill({ urgencia, rol }) {
  if (!urgencia && !rol) return null;
  const color = urgencia === 'alta' ? '#EF4444' : urgencia === 'media' ? '#F59E0B' : '#10B981';
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#2E2E2E] bg-[#0D0D0D] px-2 py-1 text-[10px] uppercase tracking-widest text-[#F2F2F2]">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {rol || 'General'} · {urgencia || 'media'}
    </span>
  );
}

export default function App() {
  const [authorized, setAuthorized] = useState(false);
  const [qr, setQr] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [connectionState, setConnectionState] = useState('');
  const [connected, setConnected] = useState(false);
  const [employee, setEmployee] = useState(null);
  const [chats, setChats] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [urgentNotifications, setUrgentNotifications] = useState(0);
  const [notificationHistory, setNotificationHistory] = useState([]);
  const [unreadNotifications, setUnreadNotifications] = useState({});
  const [classification, setClassification] = useState(null);
  const [autoReply, setAutoReply] = useState(null);
  const [summary, setSummary] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [pendingNumber, setPendingNumber] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizeError, setAuthorizeError] = useState(null);
  const [pendingNumberError, setPendingNumberError] = useState(null);
  const [view, setView] = useState(() => initialDashboardView(window.location.search, window.location.hostname));
  const [chatTab, setChatTab] = useState('chats');
  const [batchItems, setBatchItems] = useState([]);
  const [batchDrafts, setBatchDrafts] = useState({});
  const [batchSending, setBatchSending] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ sent: 0, total: 0 });
  const [batchRespondido, setBatchRespondido] = useState({});
  const [homeFilter, setHomeFilter] = useState('all');
  const [batchLoading, setBatchLoading] = useState(false);
  const [homeLoading, setHomeLoading] = useState(false);
  const [ceoQuestion, setCeoQuestion] = useState('');
  const [ceoAnswer, setCeoAnswer] = useState(null);
  const [ceoLoading, setCeoLoading] = useState(false);
  const [homeSummary, setHomeSummary] = useState({ urgentes: 0, pendientes: 0, informacion: 0 });
  const [importView, setImportView] = useState(false);
  const [importChatId, setImportChatId] = useState('');
  const [importNombre, setImportNombre] = useState('');
  const [importMensajes, setImportMensajes] = useState([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const sendBrowserNotification = useCallback((chatId, text, classificationData) => {
    if (isCeoView(view) || !notificationsEnabled || typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    if (Notification.permission !== 'granted') return;
    const title = chatDisplayName((chats || []).find((c) => c.id === chatId) || { id: chatId });
    const body = text || 'Nuevo mensaje';
    const urgency = classificationData?.urgencia || '';
    const options = { body, icon: '/whatsapp-icon.png', badge: '/whatsapp-badge.png', tag: chatId, renotify: false, silent: !soundEnabled };
    if (urgency === 'alta') {
      options.body = `[URGENTE] ${body}`;
    }
    try {
      new Notification(title, options);
    } catch {
      // ignore
    }
  }, [chats, notificationsEnabled, soundEnabled, view]);

  const addMessageNotification = useCallback((chatId, message) => {
    if (isCeoView(view)) return;
    setNotificationHistory((prev) => {
      const next = [{ id: message.id || `${chatId}-${Date.now()}`, chatId, chatName: chatDisplayName((chats || []).find((c) => c.id === chatId) || { id: chatId }), text: message.texto || '', urgencia: message.classification?.urgencia || message.estado || 'General', timestamp: message.timestamp || new Date().toISOString() }, ...prev];
      const unique = new Map(next.map((item) => [item.id, item]));
      return Array.from(unique.values()).slice(0, 100);
    });
    setUnreadNotifications((prev) => ({ ...prev, [message.id || chatId]: true }));
    setUrgentNotifications((prev) => {
      const urgency = message.classification?.urgencia || message.estado || '';
      if (urgency === 'alta') return prev + 1;
      return prev;
    });
  }, [chats, view]);

  const sendTestNotification = useCallback((chatId, message) => {
    console.log('[test] Test notificación click', { chatId, message });
    try {
      sendBrowserNotification(chatId, message.texto, message.classification);
      addMessageNotification(chatId, message);
    } catch (err) {
      console.error('[test] Error test notificación', err);
    }
  }, [sendBrowserNotification, addMessageNotification]);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem('lyn_employee');
    setAuthorized(false);
    setEmployee(null);
    setConnected(false);
    setQr(null);
    setAuthError(null);
  }, []);

  const refreshAuth = useCallback(() => {
    setQr(null);
    setAuthError(null);
    setConnectionState('connecting');
  }, []);

  const handlePendingNumber = useCallback(async (event) => {
    event.preventDefault();
    const raw = String(pendingNumber || '').trim();
    const numero = raw.startsWith('+') ? raw.slice(1) : raw;
    if (!/^\d+$/.test(numero) || numero.length < 7) {
      setPendingNumberError('Ingresá un número válido');
      return;
    }
    setAuthorizing(true);
    setPendingNumberError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const message = typeof data?.error === 'string' ? data.error : 'No se pudo autorizar el número';
        setAuthorizeError(message);
        return;
      }
      const empleado = {
        id: data?.empleado?.id || numero,
        nombre: data?.empleado?.nombre || null,
        apellido: data?.empleado?.apellido || null,
        empresa: data?.empleado?.empresa || null,
        rol: data?.empleado?.rol_nombre || 'empleado',
        numero,
      };
      setEmployee(empleado);
      setAuthorized(true);
      localStorage.setItem('lyn_employee', JSON.stringify(empleado));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error de conexión';
      setAuthorizeError(message);
    } finally {
      setAuthorizing(false);
    }
  }, [pendingNumber]);

  useEffect(() => {
    const raw = localStorage.getItem('lyn_employee');
    if (!raw) return;
    try {
      const employee = JSON.parse(raw);
      if (employee?.numero) {
        setEmployee(employee);
        setAuthorized(true);
      }
    } catch {
      localStorage.removeItem('lyn_employee');
    }
  }, []);

  const markNotificationRead = useCallback((chatId) => {
    setUrgentNotifications((prev) => Math.max(0, prev - 1));
    setUnreadNotifications((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, []);

  const clearNotifications = useCallback(() => {
    setNotificationHistory([]);
    setUnreadNotifications({});
    setUrgentNotifications(0);
  }, []);

  const loadChats = useCallback(async () => {
    try {
      const data = await api.chats();
      const arr = Array.isArray(data) ? data : [];
      const byBase = new Map();
      const byName = new Map();
      for (const chat of arr) {
        const phone = String(chat.id || '').split('@')[0];
        const normalizedName = String(chat.nombre || chat.name || '').trim().toLowerCase();
        const current = byBase.get(phone);
        if (!current) {
          byBase.set(phone, chat);
        } else {
          const currentTime = new Date(current.updated_at || 0).getTime();
          const chatTime = new Date(chat.updated_at || 0).getTime();
          if (chatTime > currentTime) {
            byBase.set(phone, chat);
          }
        }
        if (normalizedName) {
          const existing = byName.get(normalizedName);
          if (!existing) {
            byName.set(normalizedName, chat);
          } else {
            const existingTime = new Date(existing.updated_at || 0).getTime();
            const chatTime = new Date(chat.updated_at || 0).getTime();
            if (chatTime > existingTime) {
              byName.set(normalizedName, chat);
            }
          }
        }
      }
      const merged = new Map();
      for (const chat of byBase.values()) {
        const normalizedName = String(chat.nombre || chat.name || '').trim().toLowerCase();
        const byNameChat = normalizedName ? byName.get(normalizedName) : null;
        const key = byNameChat ? `${byNameChat.id}__${normalizedName}` : chat.id;
        if (!merged.has(key)) {
          merged.set(key, byNameChat || chat);
        }
      }
      const unique = Array.from(merged.values());
      setChats(unique);
      if (!selectedChatId && unique.length > 0) {
        setSelectedChatId(unique[0].id);
      }
    } catch (error) {
      console.error('[dashboard] loadChats error:', error);
    }
  }, []);

  const loadMensajes = useCallback(async (chatId) => {
    if (!chatId) return;
    try {
      const data = await api.messages(chatId);
      const arr = Array.isArray(data) ? data : [];
      setMensajes(arr);
    } catch (error) {
      console.error('[dashboard] loadMensajes error:', error);
    }
  }, []);

  const classifyLastMessage = useCallback(async (chatId, texto) => {
    if (!chatId || !texto) return;
    try {
      const res = await fetch(`${API_BASE}/api/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: texto }),
      });
      if (!res.ok) return;
      const data = await res.json();
      console.log('[auto-classify]', chatId, data);

      setClassification((prev) => prev || {
        rol: data?.rol || 'General',
        confianza: data?.confianza || 0.5,
        necesita_accion: data?.necesita_accion || false,
        urgencia: data?.urgencia || 'media',
      });
    } catch (error) {
      console.error('[dashboard] classifyLastMessage error:', error);
    }
  }, []);

  const classifyChat = useCallback(async (chatId) => {
    if (!chatId) return;
    const messages = mensajes.filter((m) => m.chat_id === chatId);
    if (!messages.length) return;
    const last = messages[messages.length - 1]?.texto;
    if (last) classifyLastMessage(chatId, last).catch(() => {});
  }, [mensajes, classifyLastMessage]);

  const resetAi = useCallback(() => {
    setClassification(null);
    setAutoReply(null);
    setSummary(null);
  }, []);

  const handleRenameChat = useCallback(async (chatId, nombre) => {
    setChats((prev) =>
      prev.map((chat) => (chat.id === chatId ? { ...chat, nombre } : chat)),
    );
  }, []);

  useEffect(() => {
    if (!authorized) return;
    loadChats();
    const interval = setInterval(loadChats, 30000);
    return () => clearInterval(interval);
  }, [authorized, loadChats]);

  useEffect(() => {
    if (view !== 'home') return;
    let cancelled = false;
    setHomeLoading(true);
    Promise.all([api.pendientes({ usuario_id: employee?.id, es_direccion: employee?.rol === 'Dirección' || employee?.rol === 'CEO' || employee?.rol === 'admin' ? 'true' : undefined }).catch(() => []), api.ceoMetrics().catch(() => null)]).then(([pendientes, metrics]) => {
      if (cancelled) return;
      const arr = Array.isArray(pendientes) ? pendientes : [];
      const urgentes = arr.filter((p) => (p.classification?.urgencia || p.estado || '') === 'alta').length;
      const pendientesCount = arr.length;
      const informacion = Math.max(0, (metrics?.totals?.mensajes || 0) - pendientesCount);
      setHomeSummary({ urgentes, pendientes: pendientesCount, informacion });
      setBatchItems(arr);
    }).catch(() => {})
    .finally(() => { if (!cancelled) setHomeLoading(false); });
    return () => { cancelled = true; };
  }, [view]);

  useEffect(() => {
    if (view !== 'batch') return;
    let cancelled = false;
    setBatchLoading(true);
    api.pendientes().then((data) => {
      if (cancelled) return;
      const arr = Array.isArray(data) ? data : [];
      setBatchItems(arr);
    }).catch(() => {})
    .finally(() => { if (!cancelled) setBatchLoading(false); });
    return () => { cancelled = true; };
  }, [view]);

  useEffect(() => {
    const raw = localStorage.getItem('lyn_employee');
    if (!raw) return;
    try {
      const employee = JSON.parse(raw);
      if (employee?.numero) {
        setEmployee(employee);
        setAuthorized(true);
      }
    } catch {
      localStorage.removeItem('lyn_employee');
    }
  }, []);

  useEffect(() => {
    if (!shouldPollWhatsappConnection(view, connected)) return;
    let cancelled = false;
    let timer = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await api.connectionState();
        if (cancelled) return;
        const state = String(data?.state || '');
        const isConnected = Boolean(data?.connected);
        setConnectionState(state);
        if (isConnected) {
          setConnected(true);
          setQr(null);
          setAuthError(null);
          const stored = localStorage.getItem('lyn_employee');
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              setEmployee(parsed);
              setAuthorized(true);
            } catch {
              setAuthorized(false);
            }
          } else {
            setAuthorized(false);
          }
          return;
        }
        if (!qr) {
          try {
            const qrData = await api.qr();
            if (!cancelled) {
              setQr(qrData?.qr || null);
              if (!qrData?.qr) {
                setAuthError('No se pudo obtener el QR. Reintentá en unos segundos.');
              }
            }
          } catch {
            if (!cancelled) {
              setAuthError('Error obteniendo QR. Reintentá en unos segundos.');
            }
          }
        }
        timer = setTimeout(tick, 2000);
      } catch {
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, qr, view]);


  useEffect(() => {
    if (!connected || !selectedChatId) return;
    loadMensajes(selectedChatId);
  }, [connected, selectedChatId, loadMensajes]);

  const mensajesRef = useRef(mensajes);
  useEffect(() => { mensajesRef.current = mensajes; }, [mensajes]);

  useEffect(() => {
    if (!connected || typeof EventSource === 'undefined') return undefined;

    const stream = new EventSource(`${SSE_BASE}/events`);
    const refreshFromRealtimeEvent = (event) => {
      let payload = {};
      try { payload = JSON.parse(event.data || '{}'); } catch { /* ignore malformed events */ }

      loadChats();
      if (payload.chatId && payload.chatId === selectedChatId) {
        loadMensajes(selectedChatId);
      }
    };

    stream.addEventListener('message-upsert', refreshFromRealtimeEvent);
    stream.addEventListener('message-status-update', refreshFromRealtimeEvent);
    return () => stream.close();
  }, [connected, selectedChatId, loadChats, loadMensajes]);

  useEffect(() => {
    if (!connected || !selectedChatId) return;
    if (!selectedChatId) return;
    const interval = setInterval(async () => {
      try {
        const last = mensajesRef.current[mensajesRef.current.length - 1];
        const data = await api.messagesLatest(selectedChatId, last?.timestamp ? safeISOTimestamp(last.timestamp) : '');
        const arr = Array.isArray(data) ? data : [];
        if (!arr.length) return;
        setMensajes((prev) => {
          const map = new Map(prev.map((m) => [m.id, m]));
          const seen = new Set(prev.map((m) => `${m.chat_id}__${m.texto}__${safeISOTimestamp(m.timestamp)}__${m.enviado_por_mi}`));
          for (const msg of arr) {
            const key = `${msg.chat_id}__${msg.texto}__${safeISOTimestamp(msg.timestamp)}__${Boolean(msg.enviado_por_mi)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            map.set(msg.id, msg);
          }
          const merged = Array.from(map.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          return merged;
        });
        const newest = arr[arr.length - 1];
        if (newest?.texto) {
          const isMe = Boolean(newest?.enviado_por_mi);
          const remitenteNormalizado = String(newest?.remitente || newest?.remitente_jid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/@g\.us$/, '');
          const empleadoNumero = String(employee?.numero || '').replace(/\D/g, '');
          const isOwnBySender = Boolean(empleadoNumero && remitenteNormalizado && remitenteNormalizado.includes(empleadoNumero));
          if (!isMe && !isOwnBySender) {
            sendBrowserNotification(selectedChatId, newest.texto, newest.estado || undefined);
            addMessageNotification(selectedChatId, newest);
            const classificationFromPayload = newest.classification || newest.clasificacion || null;
            if (!classificationFromPayload) {
              classifyLastMessage(selectedChatId, newest.texto).catch(() => {});
            }
          }
        }
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [connected, selectedChatId, sendBrowserNotification, addMessageNotification, employee]);

  useEffect(() => {
    if (!connected || chats.length === 0) return;
    if (!selectedChatId) {
      const sorted = [...chats].sort((a, b) => {
        const aTime = new Date(a.updated_at || 0).getTime();
        const bTime = new Date(b.updated_at || 0).getTime();
        return bTime - aTime;
      });
      const mostRecent = sorted[0]?.id;
      if (mostRecent) {
        setSelectedChatId(mostRecent);
      }
    }
  }, [connected, chats, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) return;
    loadMensajes(selectedChatId);
  }, [selectedChatId, loadMensajes]);

  useEffect(() => {
    resetAi();
  }, [selectedChatId, resetAi]);

  const handleSend = useCallback(async () => {
    if (!selectedChatId || !draft.trim()) return;
    const texto = draft.trim();
    setSending(true);
    try {
      await api.sendText(selectedChatId, texto);
      await Promise.all([loadChats()]);
      setDraft('');
    } catch (error) {
      console.error('[dashboard] handleSend error:', error);
      const message = String(error?.message || '');
      if (message.includes('Connection Closed') || message.includes('502')) {
        setAuthError('Error de conexión con WhatsApp. Reintentá en unos segundos.');
      } else {
        setAuthError(message);
      }
    } finally {
      setSending(false);
    }
  }, [selectedChatId, draft, loadChats]);

  const handleBatchSend = useCallback(async () => {
    if (!Array.isArray(batchItems) || !batchItems.length) return;
    setBatchSending(true);
    setBatchProgress({ sent: 0, total: batchItems.length });
    try {
      const replies = batchItems.map((item) => ({ chatId: item.chat_id, texto: batchDrafts[item.chat_id] || item.texto || '', quedaRespondido: Boolean(batchRespondido[item.chat_id]) }));
      const data = await api.batchReply(replies, 1500);
      const failed = data?.failed || 0;
      const total = data?.total || replies.length;
      setBatchProgress({ sent: total - failed, total });
      if (failed > 0) {
        alert(`Lote enviado con errores: ${failed}/${total} fallaron`);
      } else {
        alert(`Lote enviado: ${total} respuestas`);
      }
      await loadChats();
      setBatchItems([]);
      setBatchDrafts({});
      setBatchProgress({ sent: 0, total: 0 });
    } catch (error) {
      console.error('[batch] send error:', error);
      alert('Error en el envío por lotes');
    } finally {
      setBatchSending(false);
    }
  }, [batchItems, batchDrafts, loadChats]);

const handleBatchDraftChange = useCallback((chatId, texto) => {
  setBatchDrafts((prev) => ({ ...prev, [chatId]: texto }));
}, []);
const handleBatchRespondidoChange = useCallback((chatId, value) => {
  setBatchRespondido((prev) => ({ ...prev, [chatId]: value }));
}, []);

  const handleCeoAsk = useCallback(async () => {
    const pregunta = ceoQuestion.trim();
    if (!pregunta) return;
    setCeoLoading(true);
    setCeoAnswer(null);
    try {
      const data = await api.ceoAsk(pregunta);
      setCeoAnswer(data);
    } catch (error) {
      console.error('[ceo] ask error:', error);
      setCeoAnswer({ respuesta: 'Error al consultar' });
    } finally {
      setCeoLoading(false);
    }
  }, [ceoQuestion]);

  const handleAdvancedAction = useCallback(async (key) => {
    if (!selectedChatId) return;
    const chatId = selectedChatId;
    try {
      switch (key) {
        case 'image':
        case 'video':
        case 'audio':
        case 'sticker':
        case 'document': {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = key === 'sticker' ? 'image/webp,image/png' : key === 'audio' ? 'audio/*' : key === 'video' ? 'video/*' : 'image/*,application/pdf';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
              const base64 = typeof reader.result === 'string' ? reader.result : '';
              const mediatype = key === 'ptv' ? 'video' : key;
              await api.sendMedia(chatId, mediatype, base64, file.type || 'application/octet-stream', file.name, file.name);
              await loadChats();
            };
            reader.readAsDataURL(file);
          };
          input.click();
          return;
        }
        case 'ptv': {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'video/*';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
              const base64 = typeof reader.result === 'string' ? reader.result : '';
              await api.sendPtv(chatId, base64);
              await loadChats();
            };
            reader.readAsDataURL(file);
          };
          input.click();
          return;
        }
        case 'location': {
          const lat = prompt('Latitud (ej: -34.6)');
          if (lat === null) return;
          const lng = prompt('Longitud (ej: -58.4)');
          if (lng === null) return;
          const name = prompt('Nombre del lugar') || '';
          const address = prompt('Dirección') || '';
          await api.sendLocation(chatId, Number(lat), Number(lng), name, address);
          break;
        }
        case 'contact': {
          const contactName = prompt('Nombre del contacto');
          if (contactName === null) return;
          const contactNumber = prompt('Número del contacto (ej: 5491112345678)');
          if (contactNumber === null) return;
          const contactPayload = {
            displayName: contactName,
            contacts: [{ name: contactName, phoneNumber: contactNumber }],
          };
          await api.sendContact(chatId, JSON.stringify(contactPayload));
          break;
        }
        case 'poll': {
          const name = prompt('Título de la encuesta') || '';
          const selectableCount = Number(prompt('Opciones seleccionables (1 = single choice)') || '1');
          const valuesRaw = prompt('Opciones separadas por coma (ej: Opción A, Opción B, Opción C)') || '';
          const values = valuesRaw.split(',').map((v) => v.trim()).filter(Boolean);
          await api.sendPoll(chatId, name, selectableCount, values, '');
          break;
        }
        case 'list': {
          const title = prompt('Título de la lista') || '';
          const description = prompt('Descripción') || '';
          const footerText = prompt('Texto del pie') || '';
          const buttonText = prompt('Texto del botón') || '';
          const sectionsRaw = prompt('Secciones JSON (ej: [{"title":"Sección 1","rows":[{"title":"Fila 1","description":"Desc","rowId":"1"}]}])') || '[]';
          let sections = [];
          try { sections = JSON.parse(sectionsRaw); } catch { alert('JSON inválido'); return; }
          await api.sendList(chatId, title, description, footerText, buttonText, sections);
          break;
        }
        case 'buttons': {
          const title = prompt('Título') || '';
          const description = prompt('Descripción') || '';
          const footer = prompt('Pie de página') || '';
          const buttonsRaw = prompt('Botones JSON (ej: [{"text":"Sí","value":"yes"},{"text":"No","value":"no"}])') || '[]';
          let buttons = [];
          try { buttons = JSON.parse(buttonsRaw); } catch { alert('JSON inválido'); return; }
          await api.sendButtons(chatId, title, description, footer, buttons);
          break;
        }
        case 'template': {
          const name = prompt('Nombre de la plantilla') || '';
          const language = prompt('Idioma (ej: es)') || 'es';
          const componentsRaw = prompt('Componentes JSON') || '[]';
          let components = [];
          try { components = JSON.parse(componentsRaw); } catch { alert('JSON inválido'); return; }
          await api.sendTemplate(chatId, name, language, components);
          break;
        }
        case 'status': {
          const text = prompt('Texto del estado');
          if (text === null) return;
          await api.sendStatus('text', text, [], false, text, '#202c33', 'DEFAULT');
          break;
        }
        case 'reaction': {
          const last = mensajes[mensajes.length - 1];
          if (!last) return;
          const emoji = prompt('Emoji de reacción (ej: 👍)') || '👍';
          await api.sendReaction({ key: { id: last.id, remoteJid: last.chat_id }, reaction: emoji });
          break;
        }
        case 'edit-message': {
          const last = mensajes[mensajes.length - 1];
          if (!last) return;
          const newText = prompt('Nuevo texto para el último mensaje:', last.texto);
          if (newText === null) return;
          await api.updateMessage(last.chat_id, last.id, newText);
          break;
        }
        case 'delete-message': {
          const last = mensajes[mensajes.length - 1];
          if (!last) return;
          if (!confirm('¿Eliminar último mensaje?')) return;
          await api.deleteMessage(last.id, last.chat_id, last.enviado_por_mi, null);
          setMensajes((prev) => prev.filter((m) => m.id !== last.id));
          break;
        }
        case 'chat-mute': {
          const expiration = Number(prompt('Silenciar por X segundos (0 = desilenciar, 86400 = 1 día)') || '0');
          await api.muteChat(chatId, expiration);
          break;
        }
        case 'chat-unmute': {
          await api.muteChat(chatId, 0);
          break;
        }
        case 'chat-pin': {
          await api.pinChat(chatId, true);
          break;
        }
        case 'chat-unpin': {
          await api.pinChat(chatId, false);
          break;
        }
        case 'chat-clear': {
          if (!confirm('¿Limpiar mensajes de este chat?')) return;
          await api.clearMessages(chatId);
          setMensajes([]);
          break;
        }
        case 'chat-archive': {
          await api.archiveChat(chatId, true);
          await loadChats();
          break;
        }
        case 'chat-unarchive': {
          await api.archiveChat(chatId, false);
          await loadChats();
          break;
        }
        case 'chat-delete': {
          if (!confirm('¿Eliminar chat? Esto no borra los mensajes en WhatsApp.')) return;
          await api.deleteChat(chatId);
          setMensajes([]);
          setSelectedChatId(null);
          break;
        }
        case 'chat-read': {
          break;
        }
        case 'profile-picture': {
          try {
            const data = await api.profilePictureUrl(chatId);
            const url = data?.profilePictureUrl || data?.url || data?.base64 || null;
            if (url) {
              const win = window.open('', '_blank', 'noopener,noreferrer');
              if (win) {
                win.document.write(`<img src="${url}" style="max-width:100%;background:#000;" />`);
              }
            } else {
              alert('Sin foto de perfil disponible');
            }
          } catch (error) {
            console.error('[dashboard] profile picture error:', error);
          }
          break;
        }
        default:
          console.warn('[dashboard] advanced action not implemented:', key);
      }
      await loadChats();
    } catch (error) {
      console.error('[dashboard] advanced action error:', key, error);
      alert(`Error en ${key}: ${error instanceof Error ? error.message : 'desconocido'}`);
    }
  }, [selectedChatId, loadChats, mensajes]);

  const isAdmin = employee?.rol === 'CEO' || employee?.rol === 'admin';
  const _showAdmin = useMemo(() => connected && authorized && isAdmin, [connected, authorized, isAdmin]);
  const showOperative = useMemo(() => connected && authorized, [connected, authorized]);

  const aiProps = useMemo(() => ({
    classification,
    autoReply,
    summary,
    onClassification: setClassification,
    onAutoReply: setAutoReply,
    onSummary: setSummary,
    onNotify: () => {},
    onReset: resetAi,
    onSendReply: async (text) => {
      if (!selectedChatId || !text) return;
      try {
        await api.sendText(selectedChatId, text);
        await loadChats();
      } catch (error) {
        console.error('[dashboard] send reply error:', error);
      }
    },
  }), [classification, autoReply, summary, resetAi, selectedChatId, loadChats]);


  // Vista CEO - requiere login primero
  const [ceoUser, setCeoUser] = useState(null);
  const [ceoLoginError, setCeoLoginError] = useState('');
  const [ceoLoggingIn, setCeoLoggingIn] = useState(false);

  const handleCeoLogin = useCallback(async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const usuario = formData.get('usuario');
    const contraseña = formData.get('contraseña');
    
    setCeoLoggingIn(true);
    setCeoLoginError('');
    
    try {
      const res = await fetch(`${API_BASE}/api/auth/ceo-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, contraseña }),
      });
      const data = await res.json();
      
      if (!res.ok || data.error) {
        setCeoLoginError(data.error || 'Error de autenticación');
        return;
      }
      
      setCeoUser(data.usuario);
      localStorage.setItem('lyn_ceo_user', JSON.stringify(data.usuario));
      localStorage.setItem('ceo_token', data.token || '');
    } catch (error) {
      setCeoLoginError('Error de conexión');
    } finally {
      setCeoLoggingIn(false);
    }
  }, []);

  // Restaurar solo sesiones CEO con token vigente.
  useEffect(() => {
    const stored = localStorage.getItem('lyn_ceo_user');
    const token = localStorage.getItem('ceo_token');
    if (!stored || !hasUsableCeoToken(token)) {
      localStorage.removeItem('lyn_ceo_user');
      localStorage.removeItem('ceo_token');
      return;
    }
    try {
      setCeoUser(JSON.parse(stored));
    } catch {
      localStorage.removeItem('lyn_ceo_user');
      localStorage.removeItem('ceo_token');
    }
  }, []);

  const handleCeoLogout = useCallback(() => {
    localStorage.removeItem('lyn_ceo_user');
    localStorage.removeItem('ceo_token');
    setCeoUser(null);
    setCeoLoginError('');
  }, []);

  // La sesión CEO es independiente del estado de WhatsApp.
  if (shouldShowCeoDashboard(view, ceoUser)) {
    return <CEODashboard user={ceoUser} onLogout={handleCeoLogout} />;
  }

  if (shouldShowCeoLogin(view, ceoUser)) {
    return <CeoLogin onSubmit={handleCeoLogin} submitting={ceoLoggingIn} error={ceoLoginError} />;
  }

  if (view === 'home' && showOperative) {
    return (
      <div className="flex h-screen flex-col" style={{ backgroundColor: COLORS.sidebarBg }}>
        <header className="border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>Inicio</p>
              <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>Resumen de lo no leído</p>
            </div>
            <div className="flex gap-2">
              {_showAdmin && (
                <button type="button" onClick={() => setView('ceo')} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>CEO</button>
              )}
              <button type="button" onClick={() => setView('batch')} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Bandeja</button>
              <button type="button" onClick={() => setImportView(true)} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Importar</button>
              <button type="button" onClick={() => { setBatchItems([]); api.pendientes({ usuario_id: employee?.id, es_direccion: employee?.rol === 'Dirección' || employee?.rol === 'CEO' || employee?.rol === 'admin' ? 'true' : undefined }).then((d) => setBatchItems(Array.isArray(d) ? d : [])); }} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Refrescar</button>
              <button type="button" onClick={() => setView('default')} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Chats</button>
            </div>
            <div className="flex gap-2">
              {['all', 'pendiente', 'entregado'].map((f) => (
                <button key={f} type="button" onClick={() => setHomeFilter(f)} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: homeFilter === f ? COLORS.textPrimary : COLORS.textSecondary }}>{f === 'all' ? 'Todos' : f}</button>
              ))}
            </div>
          </div>
        </header>
        {homeLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-xs" style={{ color: COLORS.textSecondary }}>Cargando resumen...</p>
          </div>
        ) : (
        <div className="grid flex-1 grid-cols-3 gap-4 p-4">
          <div className="rounded-lg border border-[#2a3942] bg-[#0b141a] p-4">
            <p className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Necesitan respuesta</p>
            <p className="mt-2 text-3xl font-light" style={{ color: COLORS.textPrimary }}>{homeSummary.pendientes}</p>
          </div>
          <div className="rounded-lg border border-[#2a3942] bg-[#0b141a] p-4">
            <p className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Urgentes</p>
            <p className="mt-2 text-3xl font-light" style={{ color: COLORS.red }}>{homeSummary.urgentes}</p>
          </div>
          <div className="rounded-lg border border-[#2a3942] bg-[#0b141a] p-4">
            <p className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Información</p>
            <p className="mt-2 text-3xl font-light" style={{ color: COLORS.textPrimary }}>{homeSummary.informacion}</p>
          </div>
        </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Pendientes</p>
            <div className="flex gap-2">
              {['all', 'pendiente', 'entregado'].map((f) => (
                <button key={f} type="button" onClick={() => setHomeFilter(f)} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: homeFilter === f ? COLORS.textPrimary : COLORS.textSecondary }}>{f === 'all' ? 'Todos' : f}</button>
              ))}
              <button type="button" onClick={() => { setBatchItems([]); api.pendientes({ usuario_id: employee?.id, es_direccion: employee?.rol === 'Dirección' || employee?.rol === 'CEO' || employee?.rol === 'admin' ? 'true' : undefined }).then((d) => setBatchItems(Array.isArray(d) ? d : [])); }} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Refrescar</button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
             {batchItems.filter((item) => homeFilter === 'all' || item.estado === homeFilter).map((item) => {
               const nombre = item.remitente || item.chat_id || 'Sin nombre';
               const iniciales = nombre.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
               return (
               <div key={item.id || item.chat_id} className="debug-card rounded-lg border border-[#2a3942] bg-[#0b141a] p-3">
                 <div className="flex items-center gap-3">
                   <div className="debug-avatar flex size-10 shrink-0 items-center justify-center bg-[#202c33] font-display text-xs font-medium text-[#e9edef]">{iniciales}</div>
                   <div className="min-w-0 flex-1 debug-text">
                     <p className="truncate text-sm font-medium text-[#e9edef]">{nombre}</p>
                     <p className="mt-1 truncate text-xs text-[#8696a0]">{item.texto}</p>
                   </div>
                 </div>
                 <div className="mt-2 flex items-center justify-between">
                   <span className="text-[10px] uppercase tracking-widest text-[#8696a0]">{item.estado || 'pendiente'}</span>
                   <button type="button" onClick={() => setSelectedChatId(item.chat_id)} className="rounded-full border border-[#2a3942] bg-[#2a3942] px-3 py-1 text-[10px] uppercase tracking-widest text-[#e9edef]">Abrir chat</button>
                 </div>
               </div>
               );
             })}
            {!batchItems.filter((item) => homeFilter === 'all' || item.estado === homeFilter).length && !homeLoading && <p className="text-xs" style={{ color: COLORS.textSecondary }}>No hay pendientes por ahora.</p>}
          </div>
        </div>
      </div>
    );
  }

  if (importView) {
    return (
      <div className="flex h-screen flex-col" style={{ backgroundColor: COLORS.sidebarBg }}>
        <header className="border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>Importar</p>
              <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>Historial exportado de WhatsApp</p>
            </div>
            <button type="button" onClick={() => { setImportView(false); setImportResult(null); }} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Cerrar</button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-2xl">
            <div className="rounded-lg border border-[#2a3942] bg-[#0b141a] p-4">
              <label className="block text-xs uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Chat ID / número</label>
              <input value={importChatId} onChange={(e) => setImportChatId(e.target.value)} placeholder="Ej: 5491112345678@s.whatsapp.net" className="mt-2 h-10 w-full rounded border border-[#2a3942] bg-[#111b21] px-3 text-sm outline-none" style={{ color: COLORS.textPrimary }} />
              <label className="mt-4 block text-xs uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Nombre del chat (opcional)</label>
              <input value={importNombre} onChange={(e) => setImportNombre(e.target.value)} placeholder="Ej: Proyecto Casa Norte" className="mt-2 h-10 w-full rounded border border-[#2a3942] bg-[#111b21] px-3 text-sm outline-none" style={{ color: COLORS.textPrimary }} />
              <label className="mt-4 block text-xs uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Archivo JSON exportado</label>
              <input type="file" accept="application/json" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  try {
                    const json = JSON.parse(reader.result);
                    const mensajes = Array.isArray(json.messages) ? json.messages : Array.isArray(json) ? json : [];
                    setImportMensajes(mensajes);
                  } catch {
                    setImportMensajes([]);
                  }
                };
                reader.readAsText(file);
              }} className="mt-2 text-xs" style={{ color: COLORS.textSecondary }} />
              <p className="mt-2 text-xs" style={{ color: COLORS.textSecondary }}>{importMensajes.length} mensajes detectados en el archivo</p>
              <button type="button" onClick={async () => {
                if (!importChatId.trim() || !importMensajes.length) return;
                setImportLoading(true);
                setImportResult(null);
                try {
                  const data = await fetch('/api/importar/historial', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId: importChatId.trim(), nombreChat: importNombre.trim() || importChatId.trim(), formato: 'json', mensajes: importMensajes.map((m) => ({
                      sender: m.sender || m.from || '',
                      text: m.text || m.body || m.message || '',
                      timestamp: m.timestamp || m.date || m.time || new Date().toISOString(),
                      tipo: m.tipo || m.type || 'text',
                      mediaBase64: m.mediaBase64 || m.base64 || '',
                      mediaMime: m.mediaMime || m.mimetype || '',
                    })) }),
                  }).then((r) => r.json());
                  setImportResult(data);
                } catch (error) {
                  setImportResult({ error: (error instanceof Error ? error.message : 'Error') });
                } finally {
                  setImportLoading(false);
                }
              }} disabled={!importChatId.trim() || !importMensajes.length || importLoading} className="mt-4 rounded-full border border-[#2a3942] bg-[#005c4b] px-4 py-2 text-[10px] uppercase tracking-widest text-white disabled:cursor-not-allowed disabled:opacity-40">{importLoading ? 'Importando...' : 'Importar historial'}</button>
              {importResult && (
                <div className="mt-4 rounded-lg border border-[#2a3942] bg-[#111b21] p-3">
                  <p className="text-xs" style={{ color: COLORS.textPrimary }}>{importResult.error ? `Error: ${importResult.error}` : `Importados: ${importResult.imported} · omitidos: ${importResult.skipped}`}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'batch' && showOperative) {
    return (
      <div className="flex h-screen flex-col" style={{ backgroundColor: COLORS.sidebarBg }}>
        <header className="border-b border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.25em]" style={{ color: COLORS.textSecondary }}>Bandeja</p>
              <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>Respuestas en lote</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setView('home')} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Inicio</button>
              <button type="button" onClick={() => { setBatchItems([]); api.pendientes({ usuario_id: employee?.id, es_direccion: employee?.rol === 'Dirección' || employee?.rol === 'CEO' || employee?.rol === 'admin' ? 'true' : undefined }).then((d) => setBatchItems(Array.isArray(d) ? d : [])); }} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Refrescar</button>
              <button type="button" onClick={() => setView('default')} className="rounded-full border border-[#2a3942] bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Chats</button>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {batchLoading ? (
            <p className="text-xs" style={{ color: COLORS.textSecondary }}>Cargando bandeja...</p>
          ) : batchItems.length === 0 ? (
            <p className="text-xs" style={{ color: COLORS.textSecondary }}>No hay pendientes para responder.</p>
          ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {batchItems.map((item) => (
              <div key={item.id || item.chat_id} className="rounded-lg border border-[#2a3942] bg-[#0b141a] p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium" style={{ color: COLORS.textPrimary }}>{item.remitente || item.chat_id}</p>
                    <p className="mt-1 truncate text-xs" style={{ color: COLORS.textSecondary }}>{item.texto}</p>
                  </div>
                  <label className="ml-3 flex items-center gap-2 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={Boolean(batchRespondido[item.chat_id])}
                      onChange={(e) => handleBatchRespondidoChange(item.chat_id, e.target.checked)}
                      className="h-4 w-4 rounded border-[#2a3942] bg-[#111b21]"
                    />
                    <span className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>Queda respondido</span>
                  </label>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-widest" style={{ color: COLORS.textSecondary }}>{item.estado || 'pendiente'}</span>
                  <button type="button" onClick={() => setSelectedChatId(item.chat_id)} className="rounded-full border border-[#2a3942] bg-[#2a3942] px-3 py-1 text-[10px] uppercase tracking-widest" style={{ color: COLORS.textPrimary }}>Abrir chat</button>
                </div>
                <textarea
                  value={batchDrafts[item.chat_id] || item.texto || ''}
                  onChange={(e) => handleBatchDraftChange(item.chat_id, e.target.value)}
                  className="mt-2 h-20 w-full rounded border border-[#2a3942] bg-[#111b21] p-2 text-xs outline-none"
                  style={{ color: COLORS.textPrimary }}
                  placeholder="Escribí la respuesta..."
                />
              </div>
            ))}
          </div>
          )}
        </div>
        <footer className="border-t border-[#2a3942] px-4 py-3" style={{ backgroundColor: COLORS.sidebarHeader }}>
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: COLORS.textSecondary }}>{batchSending && batchProgress.total > 0 ? `Enviando ${batchProgress.sent}/${batchProgress.total}` : `${batchItems.length} asuntos · ${batchItems.filter((i) => i.estado === 'pendiente').length} pendientes`}</p>
            <button type="button" onClick={handleBatchSend} disabled={!batchItems.length || batchSending} className="rounded-full border border-[#2a3942] bg-[#005c4b] px-4 py-2 text-[10px] uppercase tracking-widest text-white disabled:cursor-not-allowed disabled:opacity-40">{batchSending ? 'Enviando...' : 'Enviar todo'}</button>
          </div>
        </footer>
      </div>
    );
  }

  if (view === 'ceo' && _showAdmin) {
    return <CEODashboard />;
  }

  if (showOperative) {
    return (
      <DashboardView
        chats={chats}
        selectedChatId={selectedChatId}
        onSelectChat={setSelectedChatId}
        mensajes={mensajes}
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        sending={sending}
        onAction={handleAdvancedAction}
        onRenameChat={handleRenameChat}
        aiProps={aiProps}
        notificationProps={{
          notificationsEnabled,
          setNotificationsEnabled,
          soundEnabled,
          setSoundEnabled,
          urgentNotifications,
          onNotificationRead: markNotificationRead,
          notificationHistory,
          clearNotifications,
        }}
        onTestNotification={sendTestNotification}
        activeTab={chatTab}
        onTabChange={setChatTab}
      />
    );
  }

  if (!connected) {
    return (
      <AuthView
        qr={qr}
        state={connectionState}
        error={authError}
        onRefresh={refreshAuth}
      />
    );
  }

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0d0f12] px-6">
        <form onSubmit={handlePendingNumber} className="w-full max-w-md border border-[#2E2E2E] bg-[#141414] p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-[#737373]">Superagente</p>
          <h1 className="mt-3 text-2xl font-light text-[#F2F2F2]">Autorizar acceso</h1>
          <p className="mt-2 text-sm text-[#737373]">Ingresá el número vinculado para acceder al dashboard operativo.</p>
          <input
            value={pendingNumber}
            onChange={(e) => { setPendingNumber(e.target.value.replace(/\D/g, '')); setPendingNumberError(null); }}
            placeholder="Número de celular"
            className="mt-6 h-10 w-full rounded-md border border-[#2E2E2E] bg-[#0D0D0D] px-3 text-sm text-[#F2F2F2] outline-none placeholder:text-[#737373]"
          />
          <button
            type="submit"
            disabled={authorizing || !pendingNumber}
            className="mt-3 rounded-lg bg-[#BFBFBF] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {authorizing ? 'Verificando...' : 'Ingresar'}
          </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await fetch(`${API_BASE}/api/auth/demo`, { method: 'POST' });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok || data?.error) {
                    const message = typeof data?.error === 'string' ? data.error : 'No se pudo iniciar el modo demo';
                    setAuthorizeError(message);
                    return;
                  }
                  const empleado = {
                    id: data?.empleado?.id || 'demo',
                    nombre: data?.empleado?.nombre || 'Demo',
                    apellido: data?.empleado?.apellido || 'Local',
                    empresa: data?.empleado?.empresa || 'Grupo LYN',
                    rol: data?.empleado?.rol_nombre || 'CEO',
                    numero: '0000000000',
                  };
                  setEmployee(empleado);
                  setAuthorized(true);
                  localStorage.setItem('lyn_employee', JSON.stringify(empleado));
                } catch (error) {
                  const message = error instanceof Error ? error.message : 'Error de conexión';
                  setAuthorizeError(message);
                }
              }}
              className="mt-3 ml-3 rounded-lg border border-[#2E2E2E] bg-[#0D0D0D] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-[#F2F2F2]"
            >
              Modo demo
            </button>
          {(authorizeError || pendingNumberError) && <p className="mt-4 text-xs text-red-400">{authorizeError || pendingNumberError}</p>}
        </form>
      </div>
    );
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlView = params.get('view');
    if (!urlView && _showAdmin) {
      setView('ceo');
    }
  }, [_showAdmin]);

  return (
    <DashboardView
      chats={chats}
      selectedChatId={selectedChatId}
      onSelectChat={setSelectedChatId}
      mensajes={mensajes}
      draft={draft}
      onDraftChange={setDraft}
      onSend={handleSend}
      sending={sending}
      onAction={handleAdvancedAction}
      onRenameChat={handleRenameChat}
      aiProps={aiProps}
      notificationProps={{
        notificationsEnabled,
        setNotificationsEnabled,
        soundEnabled,
        setSoundEnabled,
        urgentNotifications,
        onNotificationRead: markNotificationRead,
        notificationHistory,
        clearNotifications,
      }}
      onTestNotification={sendTestNotification}
      activeTab={chatTab}
      onTabChange={setChatTab}
    />
  );
}

export { AuthView, ChatList, ChatHeader, MessageTimeline };
