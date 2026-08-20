import { getLatestMessageTimestamp, mergeMessages } from '../lib/message-sync.js';
const SYNC_CHATS_ALARM = 'lyn-sync-chats';
const SYNC_MESSAGES_ALARM = 'lyn-sync-messages';
const MAX_MESSAGES_PER_CHAT = 200;
const EXTENSION_API_PATHS = [
  /^\/auth\/(status|qr|authorize)$/, /^\/chats$/, /^\/chats\/ensure$/, /^\/chats\/unread-reconcile$/, /^\/chats\/[^/]+\/mensajes(?:\/latest)?$/, /^\/chats\/[^/]+\/(read|name|resolve-name)$/,
  /^\/mensajes\/changes$/, /^\/enviar$/, /^\/classify$/, /^\/specialists(?:\/[^/]+)?$/, /^\/chat\/summary$/, /^\/chat\/reply$/, /^\/chat\/[^/]+\/(summaries|replies)$/, /^\/ai\/auto-reply$/, /^\/sincronizar$/, /^\/pendientes$/,
];

function isAllowedExtensionApiPath(path) {
  const pathname = String(path || '').split('?')[0];
  return EXTENSION_API_PATHS.some((pattern) => pattern.test(pathname));
}
let chatSyncPromise = null;
let messageSyncPromise = null;
const chatMessageSyncPromises = new Map();
let initialized = false;

async function getStorage(keys, defaults = {}) {
  const defaultValues = !Array.isArray(keys) && keys && typeof keys === 'object' ? keys : defaults;
  const keyList = Array.isArray(keys) ? keys : Object.keys(defaultValues);
  try {
    const data = await chrome.storage.local.get(keyList);
    return { ...defaultValues, ...data };
  } catch (error) {
    console.warn('[sw] storage read error:', error);
    return defaultValues;
  }
}

async function backendRequest(path, options = {}, retries = 2) {
  if (!isAllowedExtensionApiPath(path)) throw new Error('Ruta no disponible para la extensión activada.');
  const storage = await getStorage(['backendUrl', 'extensionActivationId'], { backendUrl: 'http://127.0.0.1:3003', extensionActivationId: '' });
  const base = String(storage.backendUrl || 'http://127.0.0.1:3003').replace(/\/$/, '');
  const url = `${base}/api${path}`;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(storage.extensionActivationId ? { 'X-Extension-Activation': String(storage.extensionActivationId) } : {}), ...(options.headers || {}) },
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status}: ${body || response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return await response.json().catch(() => null);
    } catch (error) {
      const retryable = error?.name === 'AbortError' || !error?.status;
      if (attempt >= retries - 1 || !retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function isWorkspaceActivated() {
  const storage = await getStorage({ extensionActivationId: '' });
  return Boolean(String(storage.extensionActivationId || '').trim());
}

async function syncChats() {
  if (!(await isWorkspaceActivated())) return;
  if (chatSyncPromise) return chatSyncPromise;
  chatSyncPromise = (async () => {
    try {
      const data = await backendRequest('/chats');
      await chrome.storage.local.set({ chats: Array.isArray(data) ? data : [], lastChatSync: Date.now() });
    } catch (error) {
      console.error('[sw] syncChats error:', error);
    } finally {
      chatSyncPromise = null;
    }
  })();
  return chatSyncPromise;
}

function latestCachedTimestamp(messages) {
  return Object.values(messages)
    .flat()
    .map((message) => getLatestMessageTimestamp([message]))
    .filter(Boolean)
    .sort()
    .at(-1) || '';
}

async function syncMessages({ full = false } = {}) {
  if (!(await isWorkspaceActivated())) return;
  if (messageSyncPromise) return messageSyncPromise;
  messageSyncPromise = (async () => {
    try {
      const storage = await getStorage({ chats: [], messages: {}, lastMessageCursor: '', messageCacheSeeded: false });
      const chats = Array.isArray(storage.chats) ? storage.chats : [];
      const messages = storage.messages || {};
      const seedCache = full || !storage.messageCacheSeeded;
      if (seedCache) {
        const chatIds = chats.map((chat) => String(chat?.id || '').trim()).filter(Boolean);
        for (let index = 0; index < chatIds.length; index += 6) {
          await Promise.all(chatIds.slice(index, index + 6).map(async (chatId) => {
            const existing = Array.isArray(messages[chatId]) ? messages[chatId] : [];
            const since = getLatestMessageTimestamp(existing);
            const data = await backendRequest(`/chats/${encodeURIComponent(chatId)}/mensajes/latest?since=${encodeURIComponent(since)}`);
            messages[chatId] = mergeMessages(existing, Array.isArray(data) ? data : [], MAX_MESSAGES_PER_CHAT);
          }));
        }
      } else {
        const cursor = String(storage.lastMessageCursor || '').trim();
        if (cursor) {
          const data = await backendRequest(`/mensajes/changes?since=${encodeURIComponent(cursor)}`);
          for (const message of (Array.isArray(data?.messages) ? data.messages : [])) {
            const chatId = String(message?.chat_id || message?.chatId || '').trim();
            if (!chatId) continue;
            messages[chatId] = mergeMessages(Array.isArray(messages[chatId]) ? messages[chatId] : [], [message], MAX_MESSAGES_PER_CHAT);
          }
          if (data?.cursor) storage.lastMessageCursor = String(data.cursor);
        }
      }
      for (const chatId of Object.keys(messages)) {
        if (Array.isArray(messages[chatId]) && messages[chatId].length > MAX_MESSAGES_PER_CHAT) {
          messages[chatId] = messages[chatId].slice(-MAX_MESSAGES_PER_CHAT);
        }
      }
      await chrome.storage.local.set({
        messages,
        messageCacheSeeded: true,
        lastMessageCursor: storage.lastMessageCursor || latestCachedTimestamp(messages) || new Date().toISOString(),
        lastMessageSync: Date.now(),
      });
    } catch (error) {
      console.error('[sw] syncMessages error:', error);
    } finally {
      messageSyncPromise = null;
    }
  })();
  return messageSyncPromise;
}

async function syncMessagesForChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id || !(await isWorkspaceActivated())) return;
  if (chatMessageSyncPromises.has(id)) return chatMessageSyncPromises.get(id);
  const task = (async () => {
    const storage = await getStorage({ messages: {} });
    const messages = storage.messages || {};
    const existing = Array.isArray(messages[id]) ? messages[id] : [];
    const since = getLatestMessageTimestamp(existing);
    const data = await backendRequest(`/chats/${encodeURIComponent(id)}/mensajes/latest?since=${encodeURIComponent(since)}`);
    messages[id] = mergeMessages(existing, Array.isArray(data) ? data : [], MAX_MESSAGES_PER_CHAT);
    await chrome.storage.local.set({ messages, lastMessageSync: Date.now() });
  })();
  chatMessageSyncPromises.set(id, task);
  try {
    await task;
  } finally {
    chatMessageSyncPromises.delete(id);
  }
}

async function reconcileWhatsAppWebUnreadChats() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  const responses = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return null;
    try { return await chrome.tabs.sendMessage(tab.id, { type: 'GET_WHATSAPP_UNREADS' }); } catch { return null; }
  }));
  const chats = responses.flatMap((response) => Array.isArray(response?.chats) ? response.chats : []);
  const observedChatIds = responses.flatMap((response) => Array.isArray(response?.observedChatIds) ? response.observedChatIds : []);
  if (chats.length || observedChatIds.length) {
    await backendRequest('/chats/unread-reconcile', { method: 'POST', body: JSON.stringify({ chats, observedChatIds }) });
  }
}
async function ensureAlarms() {
  await chrome.alarms.create(SYNC_CHATS_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  await chrome.alarms.create(SYNC_MESSAGES_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
}

async function activateRealtimeBridge() {
  await chrome.storage.local.remove('realtimeOwner');
}

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
// Inicialización: esperar storage listo antes de abrir conexiones
async function startActivatedWorkspace() {
  if (!(await isWorkspaceActivated())) return false;
  await ensureAlarms();
  await activateRealtimeBridge();
  await syncChats();
  await syncMessages();
  return true;
}

(async function init() {
  const defaults = { backendUrl: 'http://127.0.0.1:3003', extensionActivationId: '' };
  const storage = await getStorage(['backendUrl', 'extensionActivationId'], defaults);
  if (!storage.backendUrl) await chrome.storage.local.set({ backendUrl: defaults.backendUrl });
  initialized = true;
  await configureSidePanel();
  await startActivatedWorkspace();
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[sw] onMessage:', message.type, 'from:', sender?.tab?.url || sender?.url || 'background');
  (async () => {
    try {
      let result;
      const requiresActivation = ['CONNECTION_STATE', 'GET_QR', 'AUTHORIZE', 'CHATS', 'MESSAGES', 'MESSAGES_LATEST', 'SEND_TEXT'].includes(message.type);
      if (requiresActivation && !(await isWorkspaceActivated())) {
        throw new Error('Activa la extensión con el código proporcionado por tu administrador antes de vincular WhatsApp.');
      }
      if (message.type === 'CONNECTION_STATE') {
        result = await backendRequest('/auth/status');
      } else if (message.type === 'GET_QR') {
        result = await backendRequest('/auth/qr');
      } else if (message.type === 'AUTHORIZE') {
        result = await backendRequest('/auth/authorize', {
          method: 'POST',
          body: JSON.stringify({ numero: message.numero })
        });
      } else if (message.type === 'CHATS') {
        await syncChats();
        const storage = await getStorage({ chats: [] });
        result = storage.chats || [];
      } else if (message.type === 'MESSAGES') {
        const storage = await getStorage({ messages: {} });
        result = (storage.messages || {})[message.chatId] || [];
      } else if (message.type === 'MESSAGES_LATEST') {
        result = await backendRequest(`/chats/${encodeURIComponent(message.chatId)}/mensajes/latest?since=${encodeURIComponent(message.since || '')}`);
      } else if (message.type === 'SEND_TEXT') {
        result = await backendRequest('/enviar', {
          method: 'POST',
          body: JSON.stringify({ chatId: message.chatId, texto: message.text, respuestaId: message.respuestaId })
        });
        Promise.all([syncChats(), syncMessagesForChat(message.chatId)])
          .catch((error) => console.error('[sw] sync after send error:', error));
      } else if (message.type === 'CLASSIFY') {
        result = await backendRequest('/classify', {
          method: 'POST',
          body: JSON.stringify({ mensaje: message.text })
        });
      } else if (message.type === 'PENDENTS') {
        const query = new URLSearchParams();
        if (message.usuario_id) query.set('usuario_id', message.usuario_id);
        if (message.es_direccion) query.set('es_direccion', message.es_direccion);
        const qs = query.toString();
        result = await backendRequest(`/pendientes${qs ? `?${qs}` : ''}`);
      } else if (message.type === 'SPECIALISTS') {
        result = await backendRequest('/specialists');
      } else if (message.type === 'CHAT_SUMMARY') {
        result = await backendRequest('/chat/summary', {
          method: 'POST',
          body: JSON.stringify({ chatId: message.chatId, specialistId: message.specialistId })
        });
      } else if (message.type === 'SUGGESTED_REPLY') {
        result = await backendRequest('/chat/reply', {
          method: 'POST',
          body: JSON.stringify({ chatId: message.chatId, specialistId: message.specialistId })
        });
      } else if (message.type === 'CHAT_SUMMARIES') {
        result = await backendRequest(`/chat/${encodeURIComponent(message.chatId)}/summaries`);
      } else if (message.type === 'CHAT_REPLIES') {
        result = await backendRequest(`/chat/${encodeURIComponent(message.chatId)}/replies`);
      } else if (message.type === 'SYNC_NOW') {
        await reconcileWhatsAppWebUnreadChats();
        await backendRequest('/sincronizar', { method: 'POST' });
        await syncChats();
        await syncMessages();
        result = { ok: true };
      } else if (message.type === 'SYNC_LIVE') {
        await Promise.all([syncChats(), syncMessages()]);
        result = { ok: true };
      } else if (message.type === 'RECONCILE_UNREADS') {
        result = await backendRequest('/chats/unread-reconcile', {
          method: 'POST',
          body: JSON.stringify({ chats: message.chats, observedChatIds: message.observedChatIds })
        });
        await syncChats();
      } else if (message.type === 'MARK_CHAT_READ') {
        result = await backendRequest(`/chats/${encodeURIComponent(message.chatId)}/read`, { method: 'POST' });
        await syncChats();
      } else if (message.type === 'REALTIME_EVENT') {
        const eventName = String(message.event || '');
        const data = message.data && typeof message.data === 'object' ? message.data : {};
        const chatId = String(data.chatId || '').trim();
        if (eventName === 'message-upsert' && chatId) {
          await Promise.all([syncChats(), syncMessagesForChat(chatId)]);
        } else if (eventName === 'message-status-update' && chatId) {
          await syncMessagesForChat(chatId);
        } else {
          await syncChats();
        }
        result = { ok: true };
      } else if (message.type === 'EVOLUTION_CONNECTION_STATE') {
        result = await backendRequest('/auth/status');
      } else if (message.type === 'EVOLUTION_QR') {
        result = await backendRequest('/auth/qr');
      } else if (message.type === 'RESOLVE_CHAT_NAME') {
        const nameResult = await backendRequest(`/chats/${encodeURIComponent(message.chatId)}/resolve-name`, { method: 'POST' });
        result = typeof nameResult?.nombre === 'string' ? nameResult.nombre : '';
      } else if (message.type === 'API_REQUEST') {
        result = await backendRequest(message.path, message.options || {});
      } else {
        console.warn('[sw] Unknown message type:', message.type);
        throw new Error(`Unknown message type: ${message.type}`);
      }
      console.log('[sw] Responded:', message.type);
      sendResponse({ ok: true, data: result });
    } catch (error) {
      console.error('[sw] Error handling message:', message.type, error);
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const defaults = {
      backendUrl: 'http://127.0.0.1:3003',
      employee: null,
      authorized: false,
      connected: false,
      connectionState: '',
      qr: null,
      authError: null,
      chats: [],
      messages: {},
      lastMessageCursor: '',
      messageCacheSeeded: false,
      extensionActivationId: '',
      lastChatSync: 0,
      lastMessageSync: 0,
      privacyMode: false
    };
    // En una actualización se conserva la sesión, configuración y caché del usuario.
    const existing = await chrome.storage.local.get(defaults);
    await chrome.storage.local.set(existing);
    await configureSidePanel();
    await startActivatedWorkspace();
  } catch (error) {
    console.error('[bg] onInstalled error:', error);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_CHATS_ALARM) {
    await syncChats();
  } else if (alarm.name === SYNC_MESSAGES_ALARM) {
    await syncMessages();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    if (!initialized) {
      const defaults = {
        backendUrl: 'http://127.0.0.1:3003',
        extensionActivationId: ''
      };
      await getStorage(['backendUrl', 'extensionActivationId'], defaults);
      initialized = true;
    }
    await configureSidePanel();
    await startActivatedWorkspace();
  } catch (error) {
    console.error('[bg] onStartup error:', error);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.extensionActivationId?.newValue) {
    startActivatedWorkspace().catch((error) => console.error('[sw] activation start error:', error));
  }
  if (changes.backendUrl) {
    activateRealtimeBridge().catch((error) => console.error('[sw] realtime bridge error:', error));
    syncChats();
  }
});
