const state = {
  connected: false,
  roles: [],
  selectedChatId: null,
  selectedChatName: null,
  defaultSpecialistId: '',
  loading: false,
  chats: [],
  messages: [],
  reply: null,
  cardOpen: false,
  autoSummaryInFlight: false,
  lastAutoSummarySignature: '',
  summaries: {},
  replies: {},
  reviewedChats: {},
  selectedChatIds: new Set(),
  replyInFlight: new Set(),
  summaryInFlight: new Set(),
  selectedSendInFlight: false,
  chatOrder: [],
  openChatId: null,
};

let connectionPollTimer = null;

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function contextDescription(data) {
  const pending = Number(data?.mensajes_pendientes);
  const analyzed = Number(data?.mensajes_analizados);
  if (!Number.isFinite(pending) || !Number.isFinite(analyzed)) return '';
  return `Analizados: ${analyzed} de ${pending} mensajes no leidos pendientes.`;
}

function showPanel(panelId) {
  ['panel-login', 'panel-role-setup', 'panel-main', 'panel-chat'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== panelId);
  });
}

function setStatus(status) {
  const dotLogin = $('status-dot-login');
  const textLogin = $('status-text-login');
  const dotMain = $('status-dot-main');
  const textMain = $('status-text-main');
  const dotChat = $('status-dot-chat');
  const textChat = $('status-text-chat');

  [dotLogin, dotMain, dotChat].forEach((dot) => {
    dot.className = 'dot';
    if (status?.connected) dot.classList.add('ok');
    else if (status?.state) dot.classList.add('warn');
  });

  const label = status?.connected ? 'Conectado' : (status?.state || 'Desconectado');
  if (textLogin) textLogin.textContent = label;
  if (textMain) textMain.textContent = label;
  if (textChat) textChat.textContent = label;
}

async function backendMessage(type, payload = {}, retries = 2) {
  const attempt = async (attemptNumber) => {
    return new Promise((resolve, reject) => {
      const timeoutMs = ['SEND_TEXT', 'SYNC_NOW', 'CHAT_SUMMARY', 'SUGGESTED_REPLY', 'API_REQUEST'].includes(type) ? 75_000 : 15_000;
      const timeout = setTimeout(() => reject(new Error('Sin respuesta del service worker')), timeoutMs);
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        clearTimeout(timeout);
        if (!response) return reject(new Error('Sin respuesta del service worker'));
        if (response.ok) return resolve(response.data);
        const error = new Error(response.error || 'Error');
        error.status = response.status;
        return reject(error);
      });
    });
  };
  for (let i = 0; i < retries; i++) {
    try {
      return await attempt(i);
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function directBackendRequest(path, options = {}, retries = 2) {
  const useServiceWorker = typeof chrome !== 'undefined' && chrome.runtime?.sendMessage;

  if (useServiceWorker) {
    const attempt = async (attemptNumber) => {
      try {
        return await backendMessage('API_REQUEST', { path, options });
      } catch (error) {
        if (attemptNumber < retries - 1) {
          await new Promise((r) => setTimeout(r, 1000));
          return attempt(attemptNumber + 1);
        }
        throw error;
      }
    };
    return attempt(0);
  }

  const storage = await chrome.storage.local.get(['backendUrl', 'extensionActivationId']);
  const base = String(storage.backendUrl || 'http://127.0.0.1:3003').replace(/\/$/, '');
  const url = `${base}/api${path}`;

  const attempt = async (attemptNumber) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      return response.json().catch(() => null);
    } catch (error) {
      clearTimeout(timeout);
      const isAbort = error?.name === 'AbortError';
      const shouldRetry = attemptNumber < retries && (isAbort || error?.status >= 500);
      if (shouldRetry) {
        const delay = Math.min(1000 * Math.pow(2, attemptNumber), 5000);
        await new Promise((r) => setTimeout(r, delay));
        return attempt(attemptNumber + 1);
      }
      if (isAbort) {
        const timeoutError = new Error('Timeout: el backend no respondió en 60s');
        timeoutError.status = 0;
        throw timeoutError;
      }
      throw error;
    }
  };

  return attempt(0);
}

async function hasActivation() {
  const storage = await chrome.storage.local.get({ extensionActivationId: '' });
  return Boolean(String(storage.extensionActivationId || '').trim());
}

function showActivationRequired() {
  const output = $('qr-output');
  if (output) {
    output.innerHTML = `<div class="empty">Activá esta extensión con el código entregado por el CEO antes de conectar WhatsApp.</div><button id="btn-open-options" class="primary" style="margin-top:12px;">Abrir activación</button>`;
    $('btn-open-options')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }
  showPanel('panel-login');
}

function scheduleConnectionCheck() {
  if (connectionPollTimer) clearTimeout(connectionPollTimer);
  connectionPollTimer = setTimeout(async () => {
    try {
      if (!await hasActivation()) return;
      const status = await directBackendRequest('/auth/status');
      if (status?.connected) {
        await loadStatus();
        return;
      }
    } catch {
    }
    scheduleConnectionCheck();
  }, 2500);
}
async function loadStatus() {
  if (!await hasActivation()) {
    showActivationRequired();
    return;
  }
  try {
    const data = await directBackendRequest('/auth/status');
    state.connected = Boolean(data?.connected);
    setStatus(data || {});
    if (state.connected) {
      const hasDefaultRole = await loadRoles();
      if (!hasDefaultRole) {
        showPanel('panel-role-setup');
        return;
      }
      await loadChats();
      showPanel('panel-main');
    } else {
      await loadQR();
      showPanel('panel-login');
      scheduleConnectionCheck();
    }
  } catch (error) {
    console.error('[sidepanel] loadStatus error:', error);
    setStatus({ connected: false, state: 'error' });
    await loadQR();
    showPanel('panel-login');
    scheduleConnectionCheck();
  }
}

async function loadQR() {
  if (!await hasActivation()) {
    showActivationRequired();
    return;
  }
  try {
    const data = await directBackendRequest('/auth/qr');
    const qr = data?.qr || null;
    const output = $('qr-output');
    if (output) {
      if (qr) {
        output.innerHTML = `<img src="${qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`}" class="qr-image" alt="QR" />`;
      } else {
        output.innerHTML = '<div class="empty">QR no disponible</div>';
      }
    }
  } catch {
    const output = $('qr-output');
    if (output) output.innerHTML = '<div class="error">Error obteniendo QR</div>';
  }
}

async function loadRoles() {
  try {
    const data = await directBackendRequest('/specialists');
    state.roles = Array.isArray(data) ? data : [];
    const storage = await chrome.storage.local.get({ defaultSpecialistId: '' });
    const savedRoleId = String(storage.defaultSpecialistId || '').trim();
    const hasSavedRole = state.roles.some((spec) => String(spec.id) === savedRoleId);
    state.defaultSpecialistId = hasSavedRole ? savedRoleId : '';
    if (savedRoleId && !hasSavedRole) {
      await chrome.storage.local.remove('defaultSpecialistId');
    }

    const selects = [
      { element: $('specialist-select'), placeholder: 'Selecciona un rol' },
      { element: $('default-specialist-select'), placeholder: 'Selecciona un asistente' },
    ];
    selects.forEach(({ element, placeholder }) => {
      if (!element) return;
      const currentValue = String(element.value || '').trim();
      element.innerHTML = `<option value="">${placeholder}</option>`;
      state.roles.forEach((spec) => {
        const option = document.createElement('option');
        option.value = spec.id;
        option.textContent = spec.nombre || spec.id;
        element.appendChild(option);
      });
      const selectedValue = hasSavedRole ? savedRoleId : currentValue;
      if (state.roles.some((spec) => String(spec.id) === selectedValue)) {
        element.value = selectedValue;
      }
    });
    return hasSavedRole;
  } catch {
    state.roles = [];
    state.defaultSpecialistId = '';
    return false;
  }
}

function resetRoleWorkspace() {
  state.summaries = {};
  state.replies = {};
  state.reviewedChats = {};
  state.selectedChatIds.clear();
  state.lastAutoSummarySignature = '';
  renderSelectedActions();
}

async function saveDefaultRole(specialistId) {
  const roleId = String(specialistId || '').trim();
  if (!state.roles.some((spec) => String(spec.id) === roleId)) {
    const status = $('default-role-status');
    if (status) status.textContent = 'Elegí un asistente válido para continuar.';
    return false;
  }
  await chrome.storage.local.set({ defaultSpecialistId: roleId });
  state.defaultSpecialistId = roleId;
  ['specialist-select', 'default-specialist-select'].forEach((id) => {
    const select = $(id);
    if (select) select.value = roleId;
  });
  return true;
}

async function confirmDefaultRole() {
  const roleId = $('default-specialist-select')?.value;
  if (!await saveDefaultRole(roleId)) return;
  const status = $('default-role-status');
  if (status) status.textContent = 'Asistente guardado. Preparando tus chats…';
  resetRoleWorkspace();
  await loadChats();
  showPanel('panel-main');
  await generatePendingSummariesForRole(roleId);
}
function mergeVisibleChats(chats) {
    const activeChats = Array.isArray(chats) ? chats : [];
    const activeIds = new Set(activeChats.map((chat) => String(chat.id)));
    const reviewedChats = Object.values(state.reviewedChats).filter((chat) => !activeIds.has(String(chat.id)));
    return [...activeChats, ...reviewedChats];
  }

  async function loadChats() {
    const chatList = $('chat-list');
    if (!chatList) return;
    try {
      const chatsData = await backendMessage('CHATS');
      const chats = Array.isArray(chatsData) ? chatsData : [];
      state.chats = mergeVisibleChats(chats);
      renderChatList();
    } catch (error) {
      console.error('[sidepanel] Error cargando chats:', error);
      chatList.innerHTML = `<div class="error">Error cargando chats</div>`;
    }
  }

  async function resolveChatName(chatId) {
    try {
      const data = await directBackendRequest(`/chats/${encodeURIComponent(chatId)}/resolve-name`, { method: 'POST' });
      const name = typeof data?.nombre === 'string' ? data.nombre.trim() : '';
      if (name) return name;
    } catch {
      // ignore
    }
    return '';
  }

  function displayChatName(chat) {
    const name = String(chat?.nombre || '').trim();
    if (name) return name;
    const chatId = String(chat?.id || '').trim();
    const phone = chatId.match(/^(\d+)@s\.whatsapp\.net$/i)?.[1];
    return phone ? `+${phone}` : (chatId.endsWith('@g.us') ? 'Grupo sin nombre' : 'Contacto sin nombre');
  }

function renderCardBody(body, chat) {
    const chatId = chat.id;
    const messages = Array.isArray(state.messages) ? state.messages.slice().sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))) : [];
    const isGroup = String(chatId).endsWith('@g.us');
    const displayName = displayChatName(chat);
  const messagesHtml = messages.length
    ? `<div class="chat-card-section-title">Mensajes</div><div class="chat-card-messages">${messages.map((m) => {
        const from = escapeHtml(isGroup ? String(m.remitente || m.from || '') : displayName);
        const text = escapeHtml(String(m.texto || m.text || m.body || m.message || ''));
        const isMe = Boolean(m.enviado_por_mi || m.fromMe);
        const prefix = isGroup ? '👥 ' : '';
        const label = isMe ? `${prefix}[YO] ${from || 'Yo'}` : `${prefix}${from || 'Desconocido'}`;
        const className = isMe ? 'chat-message-self' : '';
        return `<div class="${className}"><b>${label}:</b> ${text}</div>`;
      }).join('')}</div>`
    : '';
  body.innerHTML = `
    <div class="chat-card-section-title">${isGroup ? '👥 ' : ''}${escapeHtml(displayName)}</div>
    <div class="chat-card-summary" data-chat-id="${escapeHtml(chatId)}"><div class="empty">Sin resumen</div></div>
    <div class="chat-card-section-title">Respuesta sugerida</div>
    <div class="chat-card-reply" data-chat-id="${escapeHtml(chatId)}"><div class="empty">Sin respuesta</div></div>
    ${messagesHtml}
    <div class="chat-card-actions">
      <button class="primary" data-action="summary" data-chat-id="${escapeHtml(chatId)}">Generar resumen</button>
      <button class="primary" data-action="reply" data-chat-id="${escapeHtml(chatId)}">Generar respuesta</button>
    </div>
    <div class="chat-card-actions" style="margin-top:8px;">
      <button class="primary" data-action="open-chat" data-chat-id="${escapeHtml(chatId)}">Ver chat completo</button>
    </div>
  `;
  body.querySelector('button[data-action="summary"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const specialistId = $('specialist-select')?.value;
    if (!specialistId) {
      alert('Selecciona un rol antes de generar el resumen');
      return;
    }
    const summaryEl = body.querySelector('.chat-card-summary');
    if (summaryEl) summaryEl.innerHTML = '<div class="empty">Generando resumen...</div>';
    try {
      const data = await directBackendRequest('/chat/summary', {
        method: 'POST',
        body: JSON.stringify({ chatId, specialistId })
      });
      const text = data?.resumen || data?.summary || '';
      if (summaryEl) {
        summaryEl.innerHTML = text ? `${escapeHtml(text)}<div class="empty">${escapeHtml(contextDescription(data))}</div>` : '<div class="error">Sin resumen generado</div>';
      }
    } catch (error) {
      if (summaryEl) summaryEl.innerHTML = `<div class="error">Error: ${escapeHtml(error.message || 'Error')}</div>`;
    }
  });
  body.querySelector('button[data-action="reply"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const specialistId = $('specialist-select')?.value;
    if (!specialistId) {
      alert('Selecciona un rol antes de generar la respuesta');
      return;
    }
    const replyEl = body.querySelector('.chat-card-reply');
    if (replyEl) replyEl.innerHTML = '<div class="empty">Generando respuesta...</div>';
    try {
      const data = await directBackendRequest('/ai/auto-reply', {
        method: 'POST',
        body: JSON.stringify({ chatId, specialistId })
      });
      const text = data?.respuesta || data?.reply || '';
      if (replyEl) {
        replyEl.innerHTML = text ? `${escapeHtml(text)}<div class="empty">${escapeHtml(contextDescription(data))}</div>` : '<div class="error">Sin respuesta generada</div>';
      }
    } catch (error) {
      if (replyEl) replyEl.innerHTML = `<div class="error">Error: ${escapeHtml(error.message || 'Error')}</div>`;
    }
  });
  body.querySelector('button[data-action="open-chat"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    openChat(chatId);
  });
}

async function openChat(chatId) {
  state.cardOpen = false;
  state.selectedChatId = chatId;
  const chat = state.chats.find((c) => c.id === chatId);
  const chatName = displayChatName(chat || { id: chatId });
  state.selectedChatName = chatName;
  const chatTitle = $('chat-title');
  if (chatTitle) chatTitle.textContent = state.selectedChatName;
  const storage = await chrome.storage.local.get({ messages: {} });
  state.messages = (storage.messages || {})[chatId] || [];
  $('summary-output').innerHTML = '<div class="empty">Seleccioná un rol y presioná Generar resumen.</div>';
  $('reply-text').value = '';
  $('reply-output').innerHTML = '<div class="empty">Seleccioná un rol, generá un resumen y luego generá una respuesta sugerida.</div>';
  showPanel('panel-chat');

}

function getSummaryForChat(chatId, specialistId) {
  const entry = state.summaries[chatId];
  return entry?.specialistId === specialistId ? entry.data : null;
}

function getReplyForChat(chatId, specialistId) {
  const entry = state.replies[chatId];
  return entry?.specialistId === specialistId ? entry.data : null;
}

function renderSelectedActions() {
  const button = $('btn-send-selected');
  const count = state.selectedChatIds.size;
  if (button) {
    button.disabled = count === 0 || state.selectedSendInFlight;
    button.textContent = state.selectedSendInFlight ? 'Enviando respuestas…' : `Responder seleccionados (${count})`;
  }
}

function renderChatDetails(body, chat) {
  const chatId = String(chat.id);
  const specialistId = $('specialist-select')?.value || '';
  const summaryData = getSummaryForChat(chatId, specialistId);
  const replyData = getReplyForChat(chatId, specialistId);
  const summaryText = String(summaryData?.resumen || summaryData?.summary || '').trim();
  const replyText = String(replyData?.respuesta || replyData?.reply || '').trim();
  const replyError = String(replyData?.error || '').trim();

  body.innerHTML = `
    <div class="chat-card-section-title">Resumen</div>
    <div class="chat-card-summary">${summaryText ? escapeHtml(summaryText) : '<div class="empty">El resumen se está preparando para el rol seleccionado.</div>'}</div>
    <div class="chat-card-section-title">Respuesta sugerida</div>
    <div class="chat-card-reply">${replyText ? escapeHtml(replyText) : (replyError ? `<div class="error">${escapeHtml(replyError)}</div>` : '<div class="empty">Generando respuesta sugerida…</div>')}</div>
  `;
}

async function hydrateSummaryForChat(chatId, specialistId) {
  const id = String(chatId);
  if (state.summaryInFlight.has(id)) return;
  state.summaryInFlight.add(id);
  try {
    const summaries = await directBackendRequest(`/chat/${encodeURIComponent(id)}/summaries`);
    const latest = (Array.isArray(summaries) ? summaries : [])
      .find((summary) => String(summary?.especialista_id || '') === String(specialistId));
    if (latest?.resumen) {
      state.summaries[id] = {
        specialistId: String(latest.especialista_id),
        data: { resumen: latest.resumen, summaryId: latest.id, specialistId: latest.especialista_id },
      };
    }
  } catch (error) {
    console.warn('[sidepanel] No se pudo recuperar el resumen:', error);
  } finally {
    state.summaryInFlight.delete(id);
  }
}

async function openChatDetails(body, chat) {
  const chatId = String(chat.id);
  const specialistId = $('specialist-select')?.value || '';
  renderChatDetails(body, chat);
  if (!specialistId) return;

  const summaryTask = !getSummaryForChat(chatId, specialistId) && !state.summaryInFlight.has(chatId)
    ? hydrateSummaryForChat(chatId, specialistId)
    : Promise.resolve();

  if (getReplyForChat(chatId, specialistId) || state.replyInFlight.has(chatId)) {
    await summaryTask;
    if (body.classList.contains('open')) renderChatDetails(body, chat);
    return;
  }

  state.replyInFlight.add(chatId);
  try {
    const data = await directBackendRequest('/ai/auto-reply', {
      method: 'POST',
      body: JSON.stringify({ chatId, specialistId }),
    });
    state.replies[chatId] = { specialistId, data };
  } catch (error) {
    state.replies[chatId] = { specialistId, data: { error: error?.message || 'No se pudo generar la respuesta' } };
  } finally {
    state.replyInFlight.delete(chatId);
    await summaryTask;
    if (body.classList.contains('open')) renderChatDetails(body, chat);
  }
}
async function sendSelectedReplies() {
  if (state.selectedSendInFlight || !state.selectedChatIds.size) return;
  const specialistId = $('specialist-select')?.value || '';
  const status = $('selection-status');
  const selectedIds = [...state.selectedChatIds];
  const missing = selectedIds.filter((chatId) => !String(getReplyForChat(chatId, specialistId)?.respuesta || '').trim());
  if (missing.length) {
    if (status) status.innerHTML = `<span class="error">Abre los ${missing.length} chats seleccionados sin respuesta sugerida antes de enviar.</span>`;
    return;
  }

  state.selectedSendInFlight = true;
  renderSelectedActions();
  if (status) status.textContent = 'Enviando respuestas seleccionadas…';
  const results = [];
  try {
    for (const [index, chatId] of selectedIds.entries()) {
      const data = getReplyForChat(chatId, specialistId);
      try {
        const result = await backendMessage('SEND_TEXT', {
          chatId,
          text: data.respuesta,
          respuestaId: data.respuestaId,
        });
        results.push({ chatId, ok: true, duplicate: Boolean(result?.duplicate) });
      } catch (error) {
        results.push({ chatId, ok: false, error: error?.message || 'No se pudo enviar' });
      }
      if (index < selectedIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
    }

    const sentIds = new Set(results.filter((item) => item.ok).map((item) => String(item.chatId)));
    sentIds.forEach((chatId) => {
      state.selectedChatIds.delete(chatId);
      delete state.summaries[chatId];
      delete state.replies[chatId];
      delete state.reviewedChats[chatId];
    });
    const failed = results.filter((item) => !item.ok);
    if (status) {
      if (failed.length) {
        status.innerHTML = `<span class="error">${sentIds.size}/${selectedIds.length} enviadas. ${escapeHtml(failed[0].error || 'Revisa los chats pendientes.')}</span>`;
      } else {
        status.textContent = `${sentIds.size}/${selectedIds.length} respuestas enviadas.`;
      }
    }
    await backendMessage('SYNC_NOW').catch(() => undefined);
    await loadChats();
  } finally {
    state.selectedSendInFlight = false;
    renderSelectedActions();
  }
}
async function generateSummary() {
  const specialistId = $('specialist-select')?.value;
  const output = $('summary-output');
  if (!specialistId || !state.selectedChatId) {
    if (output) output.innerHTML = '<div class="error">Seleccioná un chat y un rol.</div>';
    return;
  }
  setLoading(true);
  if (output) output.innerHTML = '<div class="empty">Generando resumen...</div>';
  try {
    const data = await directBackendRequest('/chat/summary', {
      method: 'POST',
      body: JSON.stringify({ chatId: state.selectedChatId, specialistId })
    });
    state.summary = data;
    if (output) {
      const text = data?.resumen || data?.summary || '';
      output.innerHTML = text ? `<div class="summary-box">${escapeHtml(text)}</div><div class="empty">${escapeHtml(contextDescription(data))}</div>` : '<div class="error">Sin resumen generado</div>';
    }
  } catch (error) {
    if (output) output.innerHTML = `<div class="error">Error generando resumen: ${escapeHtml(error.message || 'Error')}</div>`;
  } finally {
    setLoading(false);
  }
}

async function generateReply() {
  const specialistId = $('specialist-select')?.value;
  const output = $('reply-output');
  const textarea = $('reply-text');
  if (!specialistId || !state.selectedChatId) {
    if (output) output.innerHTML = '<div class="error">Seleccioná un chat y un rol.</div>';
    return;
  }
  setLoading(true);
  if (output) output.innerHTML = '<div class="empty">Generando respuesta...</div>';
  try {
    const data = await directBackendRequest('/chat/reply', {
      method: 'POST',
      body: JSON.stringify({ chatId: state.selectedChatId, specialistId })
    });
    state.reply = data;
    const replyText = data?.respuesta || data?.reply || '';
    if (textarea) textarea.value = replyText;
    if (output && replyText) {
      output.innerHTML = `<div class="empty">Respuesta lista. Editá el texto y enviá. ${escapeHtml(contextDescription(data))}</div>`;
    } else if (output) {
      output.innerHTML = '<div class="error">Sin respuesta generada</div>';
    }
  } catch (error) {
    if (output) output.innerHTML = `<div class="error">Error generando respuesta: ${escapeHtml(error.message || 'Error')}</div>`;
  } finally {
    setLoading(false);
  }
}

async function sendCurrentReply() {
  const textarea = $('reply-text');
  const text = textarea?.value?.trim();
  if (!text || !state.selectedChatId) return;
  setLoading(true);
  try {
    await backendMessage('SEND_TEXT', { chatId: state.selectedChatId, text, respuestaId: state.reply?.respuestaId });
    const output = $('reply-output');
    if (output) output.innerHTML = '<div class="empty">Respuesta enviada.</div>';
    if (textarea) textarea.value = '';
    state.reply = null;
  } catch {
    const output = $('reply-output');
    if (output) output.innerHTML = '<div class="error">Error enviando respuesta</div>';
  } finally {
    setLoading(false);
  }
}

async function copyCurrentReply() {
  const textarea = $('reply-text');
  const text = textarea?.value?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    alert('No se pudo copiar al portapapeles');
  }
}

function getSelectedRole() {
  const value = $('specialist-select')?.value;
  if (!value) {
    alert('Selecciona un rol antes de generar la respuesta');
    return null;
  }
  return value;
}

function setLoading(loading) {
  state.loading = loading;
  const selectors = [
    '.chat-card-actions button',
    '#btn-summary',
    '#btn-generate-reply',
    '#btn-send',
    '#btn-regenerate'
  ];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((btn) => {
      btn.disabled = loading;
      if (loading) {
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
      } else {
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
    });
  });
}

async function getPendingChats({ throwOnError = false } = {}) {
  try {
    const data = await directBackendRequest('/pendientes');
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('[sidepanel] Error obteniendo pendientes:', error);
    if (throwOnError) throw error;
    return [];
  }
}

async function generateAllSummaries({ pending: suppliedPending, specialistId: selectedSpecialistId } = {}) {
  const status = $('selection-status');
  const pending = Array.isArray(suppliedPending) ? suppliedPending : await getPendingChats();
  if (!pending.length) {
    if (status) status.textContent = 'No hay chats con mensajes no leídos pendientes.';
    return;
  }
  if (status) status.textContent = `Generando resúmenes de ${pending.length} chats…`;
  const results = [];
  for (const chat of pending) {
    try {
      const specialistId = selectedSpecialistId || $('specialist-select')?.value || 'general';
      const data = await directBackendRequest('/chat/summary', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.chat_id, specialistId }),
      });
      const resolvedChatId = String(data?.chatId || chat.chat_id);
      const resolvedSpecialistId = String(data?.specialistId || specialistId);
      state.summaries[resolvedChatId] = { specialistId: resolvedSpecialistId, data };
      const visibleChat = state.chats.find((item) => String(item.id) === resolvedChatId);
      state.reviewedChats[resolvedChatId] = visibleChat || {
        id: resolvedChatId,
        nombre: chat.nombre || chat.chat_nombre || resolvedChatId,
        ultimo_mensaje: chat.texto || '',
        unread_count: 0,
        updated_at: chat.timestamp,
      };
      results.push({ chatId: resolvedChatId, nombre: chat.nombre || resolvedChatId || 'Sin nombre', ok: true, resumen: data?.resumen || '', contexto: contextDescription(data) });
    } catch (error) {
      results.push({ chatId: chat.chat_id, nombre: chat.nombre || chat.chat_id || 'Sin nombre', ok: false, error: error?.message || 'Error' });
    }
  }
  const success = results.filter((r) => r.ok).length;
  const firstError = results.find((r) => !r.ok)?.error;
  if (status) {
    if (!success && firstError) status.innerHTML = `<span class="error">No se generaron resúmenes: ${escapeHtml(firstError)}</span>`;
    else status.textContent = `Resúmenes generados: ${success}/${results.length}. Abre un chat para ver su sugerencia.`;
  }
  document.querySelectorAll('.chat-card-body.open').forEach((body) => {
    const chat = state.chats.find((item) => String(item.id) === String(body.dataset.chatId));
    if (chat) renderChatDetails(body, chat);
  });
}

function pendingSignature(pending, specialistId) {
  return `${specialistId}|${pending
    .map((chat) => `${chat.chat_id}:${Number(chat.unread_count) || 0}`)
    .sort()
    .join('|')}`;
}

async function generatePendingSummariesForRole(specialistId) {
  if (!specialistId || state.autoSummaryInFlight) return;
  const status = $('selection-status');
  state.autoSummaryInFlight = true;
  try {
    if (status) status.textContent = 'Sincronizando mensajes no leídos…';
    await backendMessage('SYNC_NOW');
    await loadChats();
    const pending = await getPendingChats({ throwOnError: true });
    const signature = pendingSignature(pending, specialistId);
    if (signature === state.lastAutoSummarySignature) return;
    state.lastAutoSummarySignature = signature;
    if (!pending.length) {
      if (status) status.textContent = 'No hay chats con mensajes no leídos pendientes.';
      return;
    }
    await generateAllSummaries({ pending, specialistId });
  } catch (error) {
    if (status) status.innerHTML = `<span class="error">No se pudo sincronizar: ${escapeHtml(error?.message || 'Error')}</span>`;
  } finally {
    state.autoSummaryInFlight = false;
  }
}

async function generateBatchReplies() {
  const output = $('batch-output');
  if (!output) return;
  const pending = await getPendingChats();
  if (!pending.length) {
    output.innerHTML = '<div class="empty">No hay chats pendientes</div>';
    finishBatchSend();
    return;
  }

  output.innerHTML = '<div class="empty">Generando resúmenes...</div>';
  const summaries = new Map();
  for (const chat of pending) {
    try {
      const specialistId = getBatchRole(chat);
      const data = await directBackendRequest('/chat/summary', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.chat_id, specialistId }),
      });
      summaries.set(chat.chat_id, data?.resumen || '');
    } catch (error) {
      summaries.set(chat.chat_id, '');
    }
  }

  output.innerHTML = '<div class="empty">Generando respuestas...</div>';
  const results = [];
  for (const chat of pending) {
    try {
      const specialistId = getBatchRole(chat);
      const summary = summaries.get(chat.chat_id) || '';
      const data = await directBackendRequest('/ai/auto-reply', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.chat_id, specialistId, summary }),
      });
      results.push({ chatId: chat.chat_id, nombre: chat.nombre || chat.chat_id || 'Sin nombre', ok: true, respuesta: data?.respuesta || '', contexto: contextDescription(data) });
    } catch (error) {
      results.push({ chatId: chat.chat_id, nombre: chat.nombre || chat.chat_id || 'Sin nombre', ok: false, error: error?.message || 'Error' });
    }
  }
  const success = results.filter((r) => r.ok).length;
  output.innerHTML = buildBatchResultCards('Respuestas generadas', success, results.length, results, (item) => item.respuesta, 'respuesta');
}

function buildBatchResultCards(title, success, total, results, textGetter, emptyText) {
  const fallidos = results.filter((r) => !r.ok);
  const items = results.filter((r) => r.ok && String(textGetter(r) || '').trim());
  const html = [];
  html.push(`<div class="empty">${escapeHtml(title)}: ${success}/${total}</div>`);
  if (items.length) {
    html.push('<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">');
    for (const item of items) {
      const text = String(textGetter(item) || '').trim();
      html.push(`<div class="chat-card" style="padding:10px 12px;">`);
      html.push(`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">`);
      html.push(`<div style="min-width:0;flex:1;">`);
      html.push(`<div class="chat-card-name">${escapeHtml(item.nombre)}</div>`);
      html.push(`<div class="chat-card-meta">${escapeHtml(item.chatId || '')}</div>`);
      html.push(`</div>`);
      html.push(`<span class="badge-pill">${escapeHtml(emptyText || 'ok')}</span>`);
      html.push(`</div>`);
      html.push(`<div class="chat-card-summary" style="margin-top:8px;">${escapeHtml(text)}</div>`);
      if (item.contexto) html.push(`<div class="chat-card-meta" style="margin-top:6px;">${escapeHtml(item.contexto)}</div>`);
      html.push(`</div>`);
    }
    html.push('</div>');
  }
  if (fallidos.length) {
    html.push('<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">');
    html.push('<div class="chat-card-section-title">Errores</div>');
    for (const item of fallidos) {
      html.push(`<div style="font-size:12px;color:#EF4444;">${escapeHtml(item.nombre)}: ${escapeHtml(item.error)}</div>`);
    }
    html.push('</div>');
  }
  return html.join('');
}

async function sendBatchReplies() {
  const output = $('batch-output');
  if (!output) return;
  if (state.batchSendInFlight) return;
  state.batchSendInFlight = true;
  const sendButton = $('btn-batch-send');
  if (sendButton) sendButton.disabled = true;
  const finishBatchSend = () => {
    state.batchSendInFlight = false;
    if (sendButton) sendButton.disabled = false;
  };
  const pending = await getPendingChats();
  if (!pending.length) {
    output.innerHTML = '<div class="empty">No hay chats pendientes</div>';
    finishBatchSend();
    return;
  }
  const intervaloMs = Number(prompt('Delay entre mensajes (ms):', '2000') || '2000');
  if (!Number.isFinite(intervaloMs) || intervaloMs < 500) {
    finishBatchSend();
    output.innerHTML = '<div class="error">Delay mínimo 500ms</div>';
    return;
  }

  output.innerHTML = '<div class="empty">Generando resúmenes...</div>';
  const summaries = new Map();
  for (const chat of pending) {
    try {
      const specialistId = getBatchRole(chat);
      const data = await directBackendRequest('/chat/summary', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.chat_id, specialistId }),
      });
      summaries.set(chat.chat_id, data?.resumen || '');
    } catch (error) {
      summaries.set(chat.chat_id, '');
    }
  }

  output.innerHTML = '<div class="empty">Enviando respuestas...</div>';
  const replies = [];
  const results = [];
  for (const chat of pending) {
    try {
      const specialistId = getBatchRole(chat);
      const summary = summaries.get(chat.chat_id) || '';
      const data = await directBackendRequest('/ai/auto-reply', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.chat_id, specialistId, summary }),
      });
      const respuesta = String(data?.respuesta || '').trim();
      if (respuesta && Number.isInteger(Number(data?.respuestaId))) {
        replies.push({ chatId: chat.chat_id, texto: respuesta, quedaRespondido: true, respuestaId: data?.respuestaId });
      }
      results.push({ chatId: chat.chat_id, nombre: chat.nombre || chat.chat_id || 'Sin nombre', ok: true, respuesta, contexto: contextDescription(data) });
    } catch (error) {
      results.push({ chatId: chat.chat_id, nombre: chat.nombre || chat.chat_id || 'Sin nombre', ok: false, error: error?.message || 'Error' });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!replies.length) {
    output.innerHTML = buildBatchResultCards('Sin respuestas para enviar', 0, results.length, results, (item) => item.respuesta, 'respuesta');
    finishBatchSend();
    return;
  }
  try {
    const sendRes = await directBackendRequest('/batch/reply', {
      method: 'POST',
      body: JSON.stringify({ replies, intervalo_ms: intervaloMs }),
    });
    const success = Number(sendRes?.success || 0);
    const total = Number(sendRes?.total || replies.length);
    const sendResults = Array.isArray(sendRes?.results) ? sendRes.results : [];
    const merged = results.map((r) => {
      const detail = sendResults.find((s) => s.chatId === r.chatId);
      return { ...r, sendOk: detail?.ok, sendError: detail?.error };
    });
    await backendMessage('SYNC_NOW').catch((error) => console.warn('[sidepanel] sync after batch send error:', error));
    output.innerHTML = buildBatchResultCards('Enviados', success, total, merged, (item) => item.respuesta, 'enviado');
  } catch (error) {
    output.innerHTML = `<div class="error">Error enviando: ${escapeHtml(error?.message || 'Error')}</div>`;
  }
  finishBatchSend();
}

function init() {
  $('btn-refresh-status-login')?.addEventListener('click', () => {
    loadStatus();
    loadChats();
  });
  $('btn-refresh-status-main')?.addEventListener('click', () => {
    loadStatus();
    loadChats();
  });
  $('btn-refresh-status-chat')?.addEventListener('click', () => {
    loadStatus();
    loadChats();
  });
  $('btn-open-qr')?.addEventListener('click', loadQR);
  $('btn-refresh-chats')?.addEventListener('click', loadChats);
  $('btn-send-selected')?.addEventListener('click', sendSelectedReplies);
  $('specialist-select')?.addEventListener('change', async (event) => {
    const roleId = event.target.value;
    if (!await saveDefaultRole(roleId)) return;
    resetRoleWorkspace();
    generatePendingSummariesForRole(roleId);
  });
  $('btn-confirm-default-role')?.addEventListener('click', confirmDefaultRole);
  $('privacy-mode-toggle')?.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ privacyMode: e.target.checked });
  });

  document.getElementById('panel-main')?.addEventListener('click', (e) => {
    if (e.target.closest('select, button, input, textarea, label')) return;
    const toggle = e.target.closest?.('.chat-card-toggle');
    const targetCard = (toggle ? toggle.closest('.chat-card') : e.target.closest('.chat-card'));
    if (!targetCard) return;
    const body = targetCard.querySelector('.chat-card-body');
    if (!body) return;
    const chatId = body.getAttribute('data-chat-id');
    if (!chatId) return;
    const isOpen = body.classList.contains('open');
    if (!isOpen) {
      document.querySelectorAll('.chat-card-body.open').forEach((el) => el.classList.remove('open'));
      document.querySelectorAll('.chat-card-toggle').forEach((el) => {
        el.textContent = '+';
        el.setAttribute('aria-expanded', 'false');
      });
    }
    if (!isOpen) {
      body.classList.add('open');
      state.cardOpen = true;
      state.openChatId = chatId;
      if (toggle) {
        toggle.textContent = '−';
        toggle.setAttribute('aria-expanded', 'true');
      }
      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) openChatDetails(body, chat);
      else console.warn('[sidepanel] chat no encontrado:', chatId, state.chats?.length);
    } else {
      body.classList.remove('open');
      state.cardOpen = false;
      state.openChatId = null;
      if (toggle) {
        toggle.textContent = '+';
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
  });

  loadStatus();

  chrome.storage.local.get({ privacyMode: false }).then((data) => {
    const toggle = $('privacy-mode-toggle');
    if (toggle) toggle.checked = Boolean(data.privacyMode);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.chats) {
      state.chats = mergeVisibleChats(changes.chats.newValue || []);
      renderChatList();
    }
    if (changes.messages && state.selectedChatId) {
      state.messages = (changes.messages.newValue || {})[state.selectedChatId] || [];
      refreshMessageView();
    }
    if (changes.privacyMode !== undefined) {
      const toggle = $('privacy-mode-toggle');
      if (toggle) toggle.checked = Boolean(changes.privacyMode.newValue);
    }
    if (changes.defaultSpecialistId !== undefined) {
      state.defaultSpecialistId = String(changes.defaultSpecialistId.newValue || '').trim();
      ['specialist-select', 'default-specialist-select'].forEach((id) => {
        const select = $(id);
        if (select && state.roles.some((spec) => String(spec.id) === state.defaultSpecialistId)) {
          select.value = state.defaultSpecialistId;
        }
      });
    }
  });
}

  function renderChatList() {
    const chatList = $('chat-list');
    if (!chatList) return;
    chatList.innerHTML = '';
    const chats = Array.isArray(state.chats) ? state.chats : [];
    if (!chats.length) {
      chatList.innerHTML = '<div class="empty">Sin chats pendientes</div>';
      return;
    }
    const knownChats = new Map(chats.map((chat) => [String(chat.id), chat]));
    const knownOrder = state.chatOrder.filter((chatId) => knownChats.has(chatId));
    const newChats = chats.filter((chat) => !knownOrder.includes(String(chat.id))).sort((a, b) => {
      const aTime = new Date(a.updated_at || 0).getTime();
      const bTime = new Date(b.updated_at || 0).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return (b.unread_count || 0) - (a.unread_count || 0);
    });
    const sorted = [...newChats, ...knownOrder.map((chatId) => knownChats.get(chatId))];
    state.chatOrder = sorted.map((chat) => String(chat.id));
    sorted.forEach((chat) => {
      const card = document.createElement('div');
      card.className = 'chat-card';
      const isGroup = String(chat.id || '').endsWith('@g.us');
      const displayName = displayChatName(chat);
      const prefix = isGroup ? '👥 ' : '';
      if (isGroup) card.classList.add('group-chat');
      const urgency = chat?.classification?.urgencia || '';
      if (urgency) {
        card.classList.add(`urgency-${String(urgency).toLowerCase()}`);
      } else if ((chat.unread_count || 0) > 0) {
        card.classList.add('unread');
      }
      const badge = urgency ? `<span class="badge-pill">${escapeHtml(String(urgency))}</span>` : `<span class="badge-pill">${chat.unread_count || 0}</span>`;
      const checked = state.selectedChatIds.has(String(chat.id)) ? ' checked' : '';
      card.innerHTML = `
        <div class="chat-card-header">
          <input type="checkbox" class="chat-select" data-chat-select="${escapeHtml(chat.id)}"${checked} aria-label="Seleccionar ${escapeHtml(displayName)}" />
          <div class="chat-card-title">
            <div class="chat-card-name">${escapeHtml(prefix + displayName)}</div>
            <div class="chat-card-meta">${escapeHtml(chat.ultimo_mensaje || 'Sin mensajes')}</div>
          </div>
          ${badge}
          <button type="button" class="chat-card-toggle" data-chat-id="${escapeHtml(chat.id)}">+</button>
        </div>
        <div class="chat-card-body" data-chat-id="${escapeHtml(chat.id)}"></div>
      `;
      card.querySelector('.chat-select')?.addEventListener('change', (event) => {
        const checkbox = event.currentTarget;
        if (checkbox.checked) state.selectedChatIds.add(String(chat.id));
        else state.selectedChatIds.delete(String(chat.id));
        renderSelectedActions();
      });
      chatList.appendChild(card);
      if (state.openChatId === String(chat.id)) {
        const body = card.querySelector('.chat-card-body');
        const toggle = card.querySelector('.chat-card-toggle');
        if (body) {
          body.classList.add('open');
          openChatDetails(body, chat);
        }
        if (toggle) {
          toggle.textContent = '−';
          toggle.setAttribute('aria-expanded', 'true');
        }
      }
    });
    renderSelectedActions();
  }

  function refreshMessageView() {
    const chatTitle = $('chat-title');
    if (chatTitle && state.selectedChatId) {
      const chat = state.chats.find((c) => c.id === state.selectedChatId);
      chatTitle.textContent = displayChatName(chat || { id: state.selectedChatId });
    }
  }

init();
