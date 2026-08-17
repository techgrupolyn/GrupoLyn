const state = {
  connected: false,
  selectedChatId: null,
  specialists: [],
  summary: null,
  reply: null,
  loading: false
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setStatus(status) {
  const dot = $('status-dot');
  const text = $('status-text');
  if (!dot || !text) return;
  dot.className = 'dot';
  if (status?.connected) {
    dot.classList.add('ok');
    text.textContent = 'Conectado';
  } else if (status?.state) {
    dot.classList.add('warn');
    text.textContent = status.state;
  } else {
    text.textContent = 'Desconectado';
  }
}

async function backendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (!response) return reject(new Error('Sin respuesta del service worker'));
      if (response.ok) return resolve(response.data);
      const error = new Error(response.error || 'Error');
      error.status = response.status;
      return reject(error);
    });
  });
}

async function loadStatus() {
  try {
    const data = await backendMessage('CONNECTION_STATE');
    state.connected = Boolean(data?.connected);
    setStatus(data || {});
    if (!state.connected) {
      await loadQR();
      const chatsTab = document.querySelector('[data-panel="panel-chats"]');
      if (chatsTab) chatsTab.click();
    }
  } catch {
    setStatus({});
    await loadQR();
  }
}

async function loadQR() {
  try {
    const data = await backendMessage('GET_QR');
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

async function loadSpecialists() {
  try {
    const data = await backendMessage('SPECIALISTS');
    state.specialists = Array.isArray(data) ? data : [];
    const summarySelect = $('specialist-summary');
    const replySelect = $('specialist-reply');
    if (summarySelect) {
      summarySelect.innerHTML = '<option value="">Selecciona un especialista</option>';
      state.specialists.forEach((spec) => {
        const option = document.createElement('option');
        option.value = spec.id;
        option.textContent = spec.nombre || spec.id;
        summarySelect.appendChild(option);
      });
    }
    if (replySelect) {
      replySelect.innerHTML = '<option value="">Selecciona un especialista</option>';
      state.specialists.forEach((spec) => {
        const option = document.createElement('option');
        option.value = spec.id;
        option.textContent = spec.nombre || spec.id;
        replySelect.appendChild(option);
      });
    }
  } catch {
    state.specialists = [];
  }
}

async function loadChats() {
  const chatList = $('chat-list');
  const output = $('chat-messages');
  if (!chatList || !output) return;
  try {
    const chatsData = await backendMessage('CHATS');
    const chats = Array.isArray(chatsData) ? chatsData : [];
    const sorted = [...chats].sort((a, b) => {
      const aTime = new Date(a.updated_at || 0).getTime();
      const bTime = new Date(b.updated_at || 0).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return (b.unread_count || 0) - (a.unread_count || 0);
    });
    chatList.innerHTML = '';
    if (!sorted.length) {
      chatList.innerHTML = '<div class="empty">Sin chats</div>';
      return;
    }
    sorted.forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'chat-item';
      const isGroup = String(chat.id || '').endsWith('@g.us');
      const displayName = chat.nombre || (isGroup ? 'Grupo' : 'Contacto');
      const prefix = isGroup ? '👥 ' : '';
      if (isGroup) item.classList.add('group-chat');
      const urgency = chat?.classification?.urgencia || '';
      const badge = urgency ? `<span class="badge-pill" style="background:${urgencyColor(urgency)};color:#000;">${escapeHtml(String(urgency))}</span>` : `<span class="badge-pill">${chat.unread_count || 0}</span>`;
      item.innerHTML = `
        <div>
          <div class="chat-name">${escapeHtml(prefix + displayName)}</div>
          <div class="chat-meta">${escapeHtml(chat.ultimo_mensaje || 'Sin mensajes')}</div>
        </div>
        ${badge}
      `;
      item.addEventListener('click', async () => {
        state.selectedChatId = chat.id;
        document.querySelectorAll('.chat-item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        await loadMessages(chat.id);
        await loadSummaryHistory(chat.id);
        await loadReplyHistory(chat.id);
      });
      chatList.appendChild(item);
    });
  } catch {
    chatList.innerHTML = '<div class="error">Error cargando chats</div>';
  }
}

function urgencyColor(urgency) {
  const u = String(urgency || '').toLowerCase();
  if (u === 'urgente' || u === 'alta') return '#ef4444';
  if (u === 'pendiente' || u === 'media') return '#f59e0b';
  if (u === 'informativo' || u === 'baja') return '#10b981';
  return '#00a884';
}

async function loadMessages(chatId) {
  const output = $('chat-messages');
  if (!output || !chatId) return;
  try {
    const data = await backendMessage('MESSAGES', { chatId });
    const messages = Array.isArray(data) ? data : [];
    if (!messages.length) {
      output.innerHTML = '<div class="empty">Sin mensajes</div>';
      return;
    }
    output.innerHTML = '';
    messages.forEach((msg) => {
      const line = document.createElement('div');
      line.style.marginBottom = '6px';
      line.innerHTML = `
        <div style="font-size:11px;color:#00a884;font-weight:700;">${escapeHtml(msg.remitente || '')}</div>
        <div style="font-size:13px;color:#f2f2f2;white-space:pre-wrap;word-break:break-word;">${escapeHtml(msg.texto || '[media]')}</div>
        <div style="font-size:10px;color:#8696a0;text-align:right;">${new Date(msg.timestamp).toLocaleString()}</div>
      `;
      output.appendChild(line);
    });
  } catch {
    output.innerHTML = '<div class="error">Error cargando mensajes</div>';
  }
}

async function loadSummaryHistory(chatId) {
  const output = $('summary-history');
  if (!output || !chatId) return;
  try {
    const data = await backendMessage('CHAT_SUMMARIES', { chatId });
    const items = Array.isArray(data) ? data : [];
    if (!items.length) {
      output.innerHTML = '<div class="empty">Sin resúmenes</div>';
      return;
    }
    output.innerHTML = '';
    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'chat-item';
      el.innerHTML = `
        <div>
          <div class="chat-name">${escapeHtml(item.especialista_id || 'general')}</div>
          <div class="chat-meta">${escapeHtml((item.resumen || '').slice(0, 120))}${(item.resumen || '').length > 120 ? '...' : ''}</div>
        </div>
        <div class="badge-pill">${new Date(item.created_at).toLocaleString()}</div>
      `;
      output.appendChild(el);
    });
  } catch {
    output.innerHTML = '<div class="error">Error cargando historial</div>';
  }
}

async function loadReplyHistory(chatId) {
  const output = $('reply-history');
  if (!output || !chatId) return;
  try {
    const data = await backendMessage('CHAT_REPLIES', { chatId });
    const items = Array.isArray(data) ? data : [];
    if (!items.length) {
      output.innerHTML = '<div class="empty">Sin respuestas</div>';
      return;
    }
    output.innerHTML = '';
    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'chat-item';
      el.innerHTML = `
        <div>
          <div class="chat-name">${escapeHtml(item.especialista_id || 'general')}</div>
          <div class="chat-meta">${escapeHtml((item.respuesta || '').slice(0, 120))}${(item.respuesta || '').length > 120 ? '...' : ''}</div>
        </div>
        <div class="badge-pill">${new Date(item.created_at).toLocaleString()}</div>
      `;
      output.appendChild(el);
    });
  } catch {
    output.innerHTML = '<div class="error">Error cargando historial</div>';
  }
}

async function generateSummary() {
  const specialistId = $('specialist-summary')?.value;
  const output = $('summary-output');
  if (!specialistId || !state.selectedChatId) {
    if (output) output.innerHTML = '<div class="error">Seleccioná un chat y un especialista.</div>';
    return;
  }
  state.loading = true;
  if (output) output.innerHTML = '<div class="empty">Generando resumen...</div>';
  try {
    const data = await backendMessage('CHAT_SUMMARY', { chatId: state.selectedChatId, specialistId });
    state.summary = data;
    if (output) {
      const text = data?.resumen || data?.summary || '';
      output.innerHTML = text ? `<div style="font-size:13px;color:#f2f2f2;white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</div>` : '<div class="error">Sin resumen generado</div>';
    }
  } catch (error) {
    if (output) output.innerHTML = `<div class="error">Error generando resumen: ${escapeHtml(error.message || 'Error')}</div>`;
  } finally {
    state.loading = false;
  }
}

async function generateReply() {
  const specialistId = $('specialist-reply')?.value;
  const output = $('reply-output');
  const textarea = $('reply-text');
  if (!specialistId || !state.selectedChatId) {
    if (output) output.innerHTML = '<div class="error">Seleccioná un chat y un especialista.</div>';
    return;
  }
  state.loading = true;
  if (output) output.innerHTML = '<div class="empty">Generando respuesta...</div>';
  try {
    const data = await backendMessage('SUGGESTED_REPLY', { chatId: state.selectedChatId, specialistId });
    state.reply = data;
    const replyText = data?.respuesta || data?.reply || '';
    if (textarea) textarea.value = replyText;
    if (output && replyText) {
      output.innerHTML = '<div class="empty">Respuesta lista. Editá el texto y enviá.</div>';
    } else if (output) {
      output.innerHTML = '<div class="error">Sin respuesta generada</div>';
    }
  } catch (error) {
    if (output) output.innerHTML = `<div class="error">Error generando respuesta: ${escapeHtml(error.message || 'Error')}</div>`;
  } finally {
    state.loading = false;
  }
}

async function sendCurrentReply() {
  const textarea = $('reply-text');
  const text = textarea?.value?.trim();
  if (!text || !state.selectedChatId) return;
  try {
    await backendMessage('SEND_TEXT', { chatId: state.selectedChatId, text, respuestaId: state.reply?.respuestaId });
    const output = $('reply-output');
    if (output) output.innerHTML = '<div class="empty">Respuesta enviada.</div>';
    if (textarea) textarea.value = '';
    state.reply = null;
    await loadChats();
  } catch {
    const output = $('reply-output');
    if (output) output.innerHTML = '<div class="error">Error enviando respuesta</div>';
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

function init() {
  loadStatus();
  loadSpecialists();
  loadChats();

  $('btn-refresh-status')?.addEventListener('click', loadStatus);
  $('btn-open-qr')?.addEventListener('click', loadQR);
  $('btn-refresh-chats')?.addEventListener('click', loadChats);
  $('btn-summary')?.addEventListener('click', generateSummary);
  $('btn-reply')?.addEventListener('click', async () => {
    if (!state.selectedChatId) return;
    const specialistId = $('specialist-reply')?.value;
    if (!specialistId) {
      const output = $('reply-output');
      if (output) output.innerHTML = '<div class="error">Seleccioná un especialista para responder.</div>';
      return;
    }
    await generateReply();
    const replyPanel = document.getElementById('panel-reply');
    if (replyPanel) replyPanel.classList.remove('hidden');
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.panel === 'panel-reply');
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== 'panel-reply');
    });
  });
  $('btn-generate-reply')?.addEventListener('click', generateReply);
  $('btn-send')?.addEventListener('click', sendCurrentReply);
  $('btn-copy')?.addEventListener('click', copyCurrentReply);
  $('btn-regenerate')?.addEventListener('click', generateReply);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const panelId = tab.dataset.panel;
      document.querySelectorAll('.panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== panelId);
      });
    });
  });

  setInterval(loadStatus, 5000);

  $('popup-privacy-mode')?.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ privacyMode: e.target.checked });
  });
  chrome.storage.local.get({ privacyMode: false }).then((data) => {
    const toggle = $('popup-privacy-mode');
    if (toggle) toggle.checked = Boolean(data.privacyMode);
  });
}

init();
