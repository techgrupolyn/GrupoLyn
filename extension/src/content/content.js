(function () {
  'use strict';

  if (window.__lynSuperagenteInjected) return;
  window.__lynSuperagenteInjected = true;
  console.log('[LYN] Content script injected into:', window.location.href);

  const state = {
    connected: false,
    authorized: false,
    employee: null,
    chats: [],
    selectedChatId: null,
    messages: [],
    specialists: [],
    pendingSummary: null,
    suggestedReply: null,
    unreadCounts: {},
    loading: false,
    sidebarOpen: false,
    activePanel: 'summary'
  };

  const dom = {
    sidebar: null,
    panel: null,
    chatList: null,
    messageList: null,
    summaryView: null,
    replyView: null,
    specialistSelect: null,
    sendButton: null,
    refreshButton: null
  };

  let realtimeSource = null;
  let unreadReconcileTimer = null;
  let lastUnreadSnapshot = '';

  function normalizeWhatsappText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function extractWhatsappChatId(row) {
    const candidates = [row, ...$$('[data-id], [id], [href]', row)];
    for (const candidate of candidates) {
      const raw = [
        candidate.getAttribute('data-id'),
        candidate.getAttribute('id'),
        candidate.getAttribute('href'),
      ].filter(Boolean).join(' ');
      const match = raw.match(/[A-Za-z0-9._-]+@(?:g\.us|s\.whatsapp\.net|c\.us|lid)/i);
      if (match) return match[0].replace(/@c\.us$/i, '@s.whatsapp.net').replace(/@lid$/i, '@s.whatsapp.net');
    }
    return '';
  }

  function detectWhatsappUnreadCount(row) {
    const candidates = [row, ...row.querySelectorAll('[aria-label], [title], [data-testid*="unread"], [data-icon*="unread"]')];
    for (const candidate of candidates) {
      const indicator = normalizeWhatsappText([
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('data-testid'),
        candidate.getAttribute('data-icon'),
        candidate.getAttribute('title'),
      ].filter(Boolean).join(' '));
      if (!/(unread|no leidos?|mensajes? (?:no leidos?|sin leer))/.test(indicator)) continue;
      const signal = `${candidate.textContent || ''} ${candidate.parentElement?.textContent || ''} ${indicator}`;
      const count = Number(signal.match(/\d+/)?.[0]);
      return Number.isInteger(count) && count > 0 ? count : 1;
    }
    return 0;
  }

  function collectWhatsappUnreadChats() {
    const byChatId = new Map();
    for (const row of $$('#pane-side [role="listitem"], #pane-side [data-id], #pane-side [data-testid="cell-frame-container"]')) {
      const chatId = extractWhatsappChatId(row);
      if (!chatId) continue;
      if (!chatId.includes('@g.us')) continue;
      const unreadCount = detectWhatsappUnreadCount(row);
      if (!unreadCount) continue;
      byChatId.set(chatId, Math.max(byChatId.get(chatId) || 0, unreadCount));
    }
    return Array.from(byChatId, ([chatId, unreadCount]) => ({ chatId, unreadCount }));
  }

  async function reconcileWhatsappUnreadChats() {
    const chats = collectWhatsappUnreadChats();
    if (!chats.length) return;
    const snapshot = chats
      .map((chat) => `${chat.chatId}:${chat.unreadCount}`)
      .sort()
      .join('|');
    if (snapshot === lastUnreadSnapshot) return;
    lastUnreadSnapshot = snapshot;
    try {
      await backendMessage('RECONCILE_UNREADS', { chats });
    } catch (error) {
      lastUnreadSnapshot = '';
      console.warn('[LYN] No se pudieron reconciliar los no leídos:', error);
    }
  }

  function scheduleWhatsappUnreadReconciliation() {
    clearTimeout(unreadReconcileTimer);
    unreadReconcileTimer = setTimeout(() => {
      reconcileWhatsappUnreadChats().catch(() => {});
    }, 600);
  }

  function observeWhatsappUnreadChats() {
    waitForElement('#pane-side', 20000).then((pane) => {
      scheduleWhatsappUnreadReconciliation();
      const observer = new MutationObserver(scheduleWhatsappUnreadReconciliation);
      observer.observe(pane, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'data-testid', 'data-id'] });
      setInterval(scheduleWhatsappUnreadReconciliation, 15000);
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'GET_WHATSAPP_UNREADS') return;
    sendResponse({ chats: collectWhatsappUnreadChats() });
  });

  async function startRealtimeUpdates() {
    try {
      const { backendUrl = 'http://127.0.0.1:3003', extensionActivationId = '' } = await chrome.storage.local.get({ backendUrl: 'http://127.0.0.1:3003', extensionActivationId: '' });
      if (!String(extensionActivationId || '').trim()) return;
      const base = String(backendUrl).replace(/\/$/, '');
      realtimeSource?.close();
      realtimeSource = new EventSource(`${base}/api/events?activation_id=${encodeURIComponent(String(extensionActivationId))}`);
      for (const eventName of ['message-upsert', 'message-status-update', 'chats-updated']) {
        realtimeSource.addEventListener(eventName, (event) => {
          let data = {};
          try { data = JSON.parse(event.data || '{}'); } catch { return; }
          chrome.runtime.sendMessage({ type: 'REALTIME_EVENT', event: eventName, data }).catch(() => {});
        });
      }
      realtimeSource.onerror = () => {
        realtimeSource?.close();
        realtimeSource = null;
        setTimeout(startRealtimeUpdates, 5000);
      };
    } catch (error) {
      console.warn('[LYN] No se pudo iniciar tiempo real:', error);
      setTimeout(startRealtimeUpdates, 5000);
    }
  }
  function $(selector, parent = document) {
    return parent.querySelector(selector);
  }

  function $$(selector, parent = document) {
    return Array.from(parent.querySelectorAll(selector));
  }

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = $(selector);
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = $(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found`));
      }, timeout);
    });
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

  async function loadChats() {
    const chats = await backendMessage('CHATS');
    state.chats = Array.isArray(chats) ? chats : [];
    renderChatList();
  }

  async function loadMessages(chatId) {
    if (!chatId) return;
    const storage = await chrome.storage.local.get({ messages: {} });
    state.messages = (storage.messages || {})[chatId] || [];
    renderMessages();
  }

  async function loadSpecialists() {
    try {
      const data = await backendMessage('SPECIALISTS');
      state.specialists = Array.isArray(data) ? data : [];
      renderSpecialistSelect();
    } catch (error) {
      console.error('[LYN] Error loading specialists:', error);
    }
  }

  async function generateSummary(chatId, specialistId) {
    if (!chatId || !specialistId) return;
    state.loading = true;
    renderSummaryView();
    try {
      const data = await backendMessage('CHAT_SUMMARY', { chatId, specialistId });
      state.pendingSummary = data;
      renderSummaryView();
    } catch (error) {
      state.pendingSummary = { error: error.message || 'Error al generar resumen' };
      renderSummaryView();
    } finally {
      state.loading = false;
    }
  }

  async function generateReply(chatId, specialistId) {
    if (!chatId || !specialistId) return;
    state.loading = true;
    renderReplyView();
    try {
      const data = await backendMessage('SUGGESTED_REPLY', { chatId, specialistId });
      state.suggestedReply = data;
      renderReplyView();
    } catch (error) {
      state.suggestedReply = { error: error.message || 'Error al generar respuesta' };
      renderReplyView();
    } finally {
      state.loading = false;
    }
  }

  async function sendMessage(chatId, text) {
    if (!chatId || !text?.trim()) return;
    try {
      await backendMessage('SEND_TEXT', { chatId, text: text.trim(), respuestaId: state.suggestedReply?.respuestaId });
      const messagesData = await backendMessage('MESSAGES', { chatId });
      state.messages = Array.isArray(messagesData) ? messagesData : [];
      renderMessages();
      const chatsData = await backendMessage('CHATS');
      state.chats = Array.isArray(chatsData) ? chatsData : [];
      renderChatList();
    } catch (error) {
      console.error('[LYN] Error sending message:', error);
      alert(`Error: ${error.message || 'No se pudo enviar el mensaje'}`);
    }
  }

  function classifyMessage(text) {
    const lower = String(text || '').toLowerCase();
    if (lower.includes('urgente') || lower.includes('emergencia') || lower.includes('ahora') || lower.includes('inmediato')) {
      return 'urgente';
    }
    if (lower.includes('necesito') || lower.includes('favor') || lower.includes('ayuda') || lower.includes('responde')) {
      return 'pendiente';
    }
    return 'informativo';
  }

  function sortChats(chats) {
    return [...chats].sort((a, b) => {
      const aTime = new Date(a.updated_at || 0).getTime();
      const bTime = new Date(b.updated_at || 0).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return (b.unread_count || 0) - (a.unread_count || 0);
    });
  }

  function displayChatName(chat) {
    const name = String(chat?.nombre || '').trim();
    if (name) return name;
    const chatId = String(chat?.id || '').trim();
    const phone = chatId.match(/^(\d+)@s\.whatsapp\.net$/i)?.[1];
    return phone ? `+${phone}` : (chatId.endsWith('@g.us') ? 'Grupo sin nombre' : 'Contacto sin nombre');
  }

  function contextMeta(data) {
    const pending = Number(data?.mensajes_pendientes);
    const analyzed = Number(data?.mensajes_analizados);
    if (!Number.isFinite(pending) || !Number.isFinite(analyzed)) return '';
    return `<small class="lyn-context-meta">Analizados: ${analyzed} de ${pending} mensajes no leidos pendientes.</small>`;
  }

  function renderChatList() {
    if (!dom.chatList) return;
    const list = dom.chatList;
    list.innerHTML = '';

    if (!state.chats.length) {
      list.innerHTML = '<div class="lyn-empty">Sin conversaciones</div>';
      return;
    }

    const sorted = sortChats(state.chats);
    sorted.forEach((chat) => {
      const card = document.createElement('div');
      card.className = 'lyn-chat-card';
      const isGroup = String(chat.id || '').endsWith('@g.us');
      const displayName = displayChatName(chat);
      const prefix = isGroup ? '👥 ' : '';
      card.innerHTML = `
        <div class="lyn-chat-card-header">
          <div class="lyn-chat-card-title">
            <div class="lyn-chat-card-name">${escapeHtml(prefix + displayName)}</div>
            <div class="lyn-chat-card-meta">${escapeHtml(chat.ultimo_mensaje || 'Sin mensajes')}</div>
          </div>
          <div class="lyn-chat-badge">${chat.unread_count || 0}</div>
          <button type="button" class="lyn-chat-card-toggle" data-chat-id="${escapeHtml(chat.id)}">+</button>
        </div>
        <div class="lyn-chat-card-body" data-chat-id="${escapeHtml(chat.id)}"></div>
      `;
      if (isGroup) card.classList.add('lyn-group-chat');
      card.querySelector('.lyn-chat-card-header').addEventListener('click', () => {
        const body = card.querySelector('.lyn-chat-card-body');
        const toggle = card.querySelector('.lyn-chat-card-toggle');
        const isOpen = body.classList.contains('open');
        document.querySelectorAll('.lyn-chat-card-body.open').forEach((el) => el.classList.remove('open'));
        document.querySelectorAll('.lyn-chat-card-toggle').forEach((el) => el.textContent = '+');
        console.log('[content] toggle card:', chat.id, 'isOpen:', isOpen, 'header', !!card.querySelector('.lyn-chat-card-header'), 'body', !!body);
        if (!isOpen) {
          body.classList.add('open');
          toggle.textContent = '−';
          renderCardBody(body, chat);
        }
      });
      const toggleBtn = card.querySelector('.lyn-chat-card-toggle');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const body = card.querySelector('.lyn-chat-card-body');
          const isOpen = body.classList.contains('open');
          document.querySelectorAll('.lyn-chat-card-body.open').forEach((el) => el.classList.remove('open'));
          document.querySelectorAll('.lyn-chat-card-toggle').forEach((el) => el.textContent = '+');
          console.log('[content] toggle button card:', chat.id, 'isOpen:', isOpen);
          if (!isOpen) {
            body.classList.add('open');
            toggleBtn.textContent = '−';
            renderCardBody(body, chat);
          }
        });
      }
      list.appendChild(card);
    });
  }

  async function renderCardBody(body, chat) {
    const chatId = chat.id;
    const specialistId = dom.specialistSelect?.value;
    console.log('[content] renderCardBody:', chatId, 'specialistId:', specialistId);

    let displayName = String(chat.nombre || '').trim();
    if (!displayName) {
      displayName = String(chatId).includes('@g.us') ? 'Grupo' : 'Contacto';
    }

    body.innerHTML = `
      <div class="lyn-chat-card-section-title">${escapeHtml(displayName)}</div>
      <div class="lyn-chat-card-summary" data-chat-id="${escapeHtml(chatId)}"><div class="lyn-empty">Sin resumen</div></div>
      <div class="lyn-chat-card-section-title">Respuesta sugerida</div>
      <div class="lyn-chat-card-reply" data-chat-id="${escapeHtml(chatId)}"><div class="lyn-empty">Sin respuesta</div></div>
      <div class="lyn-chat-card-actions">
        <button class="lyn-button primary" data-action="summary" data-chat-id="${escapeHtml(chatId)}">Generar resumen</button>
        <button class="lyn-button primary" data-action="reply" data-chat-id="${escapeHtml(chatId)}">Generar respuesta</button>
      </div>
    `;
    body.querySelector('button[data-action="summary"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!specialistId) {
        alert('Selecciona un especialista antes de generar el resumen');
        return;
      }
      const summaryEl = body.querySelector('.lyn-chat-card-summary');
      if (summaryEl) summaryEl.innerHTML = '<div class="lyn-empty">Generando resumen...</div>';
      try {
        const data = await backendMessage('CHAT_SUMMARY', { chatId, specialistId });
        const text = data?.resumen || data?.summary || '';
        if (summaryEl) {
          summaryEl.innerHTML = text ? escapeHtml(text) : '<div class="lyn-error">Sin resumen generado</div>';
        }
      } catch (error) {
        if (summaryEl) summaryEl.innerHTML = `<div class="lyn-error">Error: ${escapeHtml(error.message || 'Error')}</div>`;
      }
    });
    body.querySelector('button[data-action="reply"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!specialistId) {
        alert('Selecciona un especialista antes de generar la respuesta');
        return;
      }
      const replyEl = body.querySelector('.lyn-chat-card-reply');
      if (replyEl) replyEl.innerHTML = '<div class="lyn-empty">Generando respuesta...</div>';
      try {
        const data = await backendMessage('SUGGESTED_REPLY', { chatId, specialistId });
        const text = data?.respuesta || data?.reply || '';
        if (replyEl) {
          replyEl.innerHTML = text ? escapeHtml(text) : '<div class="lyn-error">Sin respuesta generada</div>';
        }
      } catch (error) {
        if (replyEl) replyEl.innerHTML = `<div class="lyn-error">Error: ${escapeHtml(error.message || 'Error')}</div>`;
      }
    });
  }

  function renderMessages() {
    if (!dom.messageList) return;
    const container = dom.messageList;
    container.innerHTML = '';

    if (!state.messages.length) {
      container.innerHTML = '<div class="lyn-empty">Sin mensajes</div>';
      return;
    }

    const isGroup = String(state.selectedChatId || '').endsWith('@g.us');
    if (isGroup) container.classList.add('lyn-group-chat');
    else container.classList.remove('lyn-group-chat');

    state.messages.forEach((msg) => {
      const isMe = Boolean(msg.enviado_por_mi);
      const bubble = document.createElement('div');
      bubble.className = `lyn-message ${isMe ? 'me' : 'other'}`;
      if (isGroup && !isMe) bubble.classList.add('group-message');
      const selectedChat = state.chats.find((chat) => chat.id === state.selectedChatId);
      const sender = escapeHtml(isMe ? (msg.remitente || 'Yo') : (isGroup ? (msg.remitente || 'Participante') : displayChatName(selectedChat)));
      bubble.innerHTML = `
        <div class="lyn-message-bubble">
          <div class="lyn-message-sender">${sender}</div>
          <div class="lyn-message-text">${escapeHtml(msg.texto || '[media]')}</div>
          <div class="lyn-message-meta">${new Date(msg.timestamp).toLocaleString()}</div>
        </div>
      `;
      container.appendChild(bubble);
    });
  }

  function renderSpecialistSelect() {
    if (!dom.specialistSelect) return;
    const select = dom.specialistSelect;
    select.innerHTML = '';
    state.specialists.forEach((spec, index) => {
      const option = document.createElement('option');
      option.value = spec.id;
      option.textContent = spec.nombre || spec.id;
      if (index === 0) option.selected = true;
      select.appendChild(option);
    });
  }

  function renderSummaryView() {
    if (!dom.summaryView) return;
    const container = dom.summaryView;
    if (state.loading) {
      container.innerHTML = '<div class="lyn-loading">Generando resumen...</div>';
      return;
    }
    if (!state.pendingSummary) {
      container.innerHTML = '<div class="lyn-empty">Selecciona un especialista y presiona "Resumir"</div>';
      return;
    }
    if (state.pendingSummary.error) {
      container.innerHTML = `<div class="lyn-error">${escapeHtml(state.pendingSummary.error)}</div>`;
      return;
    }
    container.innerHTML = `
      <div class="lyn-summary">
        <h3>Resumen</h3>
        <p>${escapeHtml(state.pendingSummary.resumen || state.pendingSummary.summary || JSON.stringify(state.pendingSummary))}</p>
        ${contextMeta(state.pendingSummary)}
      </div>
    `;
  }

  function renderReplyView() {
    if (!dom.replyView) return;
    const container = dom.replyView;
    if (state.loading) {
      container.innerHTML = '<div class="lyn-loading">Generando respuesta...</div>';
      return;
    }
    if (!state.suggestedReply) {
      container.innerHTML = '<div class="lyn-empty">Selecciona un especialista y presione "Responder"</div>';
      return;
    }
    if (state.suggestedReply.error) {
      container.innerHTML = `<div class="lyn-error">${escapeHtml(state.suggestedReply.error)}</div>`;
      return;
    }
    const replyText = state.suggestedReply.respuesta || state.suggestedReply.reply || '';
    container.innerHTML = `
      <div class="lyn-reply">
        <h3>Respuesta sugerida</h3>
        <textarea id="lyn-reply-text" rows="6" placeholder="Editá la respuesta antes de enviarla...">${escapeHtml(replyText)}</textarea>
        ${contextMeta(state.suggestedReply)}
        <div class="lyn-reply-actions">
          <button id="lyn-reply-copy" class="lyn-button secondary">Copiar</button>
          <button id="lyn-reply-regenerate" class="lyn-button secondary">Regenerar</button>
          <button id="lyn-reply-send" class="lyn-button primary">Enviar respuesta</button>
        </div>
      </div>
    `;
    $('#lyn-reply-send', container).addEventListener('click', async () => {
      const text = $('#lyn-reply-text', container).value.trim();
      if (!text || !state.selectedChatId) return;
      try {
        await backendMessage('SEND_TEXT', { chatId: state.selectedChatId, text, respuestaId: state.suggestedReply?.respuestaId });
        const data = await backendMessage('MESSAGES', { chatId: state.selectedChatId });
        state.messages = Array.isArray(data) ? data : [];
        renderMessages();
        const chatsData = await backendMessage('CHATS');
        state.chats = Array.isArray(chatsData) ? chatsData : [];
        renderChatList();
        state.suggestedReply = null;
        renderReplyView();
      } catch (error) {
        console.error('[LYN] Error sending message:', error);
        alert(`Error: ${error.message || 'No se pudo enviar el mensaje'}`);
      }
    });
    $('#lyn-reply-copy', container).addEventListener('click', async () => {
      const text = $('#lyn-reply-text', container).value.trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        alert('No se pudo copiar al portapapeles');
      }
    });
    $('#lyn-reply-regenerate', container).addEventListener('click', async () => {
      const specialistId = $('#lyn-reply-specialist-select', dom.sidebar).value;
      if (!specialistId || !state.selectedChatId) return;
      await generateReply(state.selectedChatId, specialistId);
    });
  }

  function createSidebar() {
    if (dom.sidebar) return;
    const sidebar = document.createElement('div');
    sidebar.id = 'lyn-sidebar';
    sidebar.innerHTML = `
      <div class="lyn-header">
        <div class="lyn-title">LYN Superagente</div>
        <button id="lyn-toggle" class="lyn-toggle">−</button>
        <label class="lyn-privacy-toggle" title="Modo privacidad: leer sin marcar como leído">
          <input type="checkbox" id="lyn-privacy-mode" />
          <span>👁️</span>
        </label>
      </div>
      <div class="lyn-tabs">
        <button data-panel="summary" class="lyn-tab active">Resumen</button>
        <button data-panel="reply" class="lyn-tab">Responder</button>
        <button data-panel="chats" class="lyn-tab">Chats</button>
      </div>
      <div class="lyn-panels">
        <div id="lyn-panel-summary" class="lyn-panel">
          <select id="lyn-specialist-select" class="lyn-select"></select>
          <button id="lyn-summary-btn" class="lyn-button">Resumir</button>
          <button id="lyn-reply-btn" class="lyn-button secondary">Responder</button>
          <div id="lyn-summary-view" class="lyn-content"></div>
        </div>
        <div id="lyn-panel-reply" class="lyn-panel hidden">
          <select id="lyn-reply-specialist-select" class="lyn-select"></select>
          <button id="lyn-generate-reply-btn" class="lyn-button secondary">Generar respuesta</button>
          <div id="lyn-reply-view" class="lyn-content"></div>
        </div>
        <div id="lyn-panel-chats" class="lyn-panel hidden">
          <button id="lyn-refresh-chats" class="lyn-button small">Actualizar</button>
          <button id="lyn-sync-messages" class="lyn-button small">Sincronizar mensajes</button>
          <div id="lyn-chat-list" class="lyn-chat-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);
    dom.sidebar = sidebar;
    dom.panel = sidebar;
    dom.chatList = $('#lyn-chat-list', sidebar);
    dom.messageList = $('#lyn-message-list', sidebar);
    dom.summaryView = $('#lyn-summary-view', sidebar);
    dom.replyView = $('#lyn-reply-view', sidebar);
    dom.specialistSelect = $('#lyn-specialist-select', sidebar);

    $('#lyn-toggle', sidebar).addEventListener('click', () => {
      state.sidebarOpen = !state.sidebarOpen;
      sidebar.classList.toggle('collapsed', !state.sidebarOpen);
      $('#lyn-toggle', sidebar).textContent = state.sidebarOpen ? '−' : '+';
    });

    $$('.lyn-tab', sidebar).forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.lyn-tab', sidebar).forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.activePanel = tab.dataset.panel;
        $$('.lyn-panel', sidebar).forEach((p) => p.classList.add('hidden'));
        $(`#lyn-panel-${state.activePanel}`, sidebar).classList.remove('hidden');
      });
    });

    $('#lyn-summary-btn', sidebar).addEventListener('click', async () => {
      const specialistId = $('#lyn-specialist-select', sidebar).value;
      if (!specialistId || !state.selectedChatId) return;
      await generateSummary(state.selectedChatId, specialistId);
    });

    $('#lyn-reply-btn', sidebar).addEventListener('click', async () => {
      const specialistId = $('#lyn-specialist-select', sidebar).value;
      if (!specialistId || !state.selectedChatId) return;
      await generateReply(state.selectedChatId, specialistId);
    });

    $('#lyn-generate-reply-btn', sidebar).addEventListener('click', async () => {
      const specialistId = $('#lyn-reply-specialist-select', sidebar).value;
      if (!specialistId || !state.selectedChatId) return;
      await generateReply(state.selectedChatId, specialistId);
    });

    $('#lyn-refresh-chats', sidebar).addEventListener('click', async () => {
      await loadChats();
    });

    $('#lyn-sync-messages', sidebar).addEventListener('click', async () => {
      try {
        await backendMessage('SYNC_NOW');
        await loadChats();
      } catch (error) {
        console.error('[LYN] Error syncing messages:', error);
      }
    });

    const chatPanel = $('#lyn-panel-chats', sidebar);
    chatPanel?.addEventListener('click', (e) => {
      const target = e.target;
      const card = target.closest?.('.lyn-chat-card');
      if (!card) return;
      const body = card.querySelector('.lyn-chat-card-body');
      const toggle = card.querySelector('.lyn-chat-card-toggle');
      if (!body) return;
      const chatId = body.getAttribute('data-chat-id') || toggle?.getAttribute('data-chat-id');
      const isOpen = body.classList.contains('open');
      document.querySelectorAll('.lyn-chat-card-body.open').forEach((el) => el.classList.remove('open'));
      document.querySelectorAll('.lyn-chat-card-toggle').forEach((el) => el.textContent = '+');
      if (!isOpen) {
        body.classList.add('open');
        if (toggle) toggle.textContent = '−';
        const chat = state.chats.find((c) => c.id === chatId);
        if (chat) renderCardBody(body, chat);
      }
    });
  }

  async function selectChat(chatId) {
    state.selectedChatId = chatId;
    renderChatList();
    await loadMessages(chatId);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function applyPrivacyMode(enabled) {
    if (enabled) {
      try {
        if (window.Store && window.Store.Chat && window.Store.Chat.prototype) {
          const seenTarget = window.Store.Chat.prototype.sendSeen || window.Store.Chat.prototype.markAsRead;
          if (typeof seenTarget === 'function') {
            window.Store.Chat.prototype.sendSeen = function () {};
            window.Store.Chat.prototype.markAsRead = function () {};
          }
        }
        if (window.Store && window.Store.Msg && window.Store.Msg.prototype) {
          if (typeof window.Store.Msg.prototype.markAsRead === 'function') {
            window.Store.Msg.prototype.markAsRead = function () {};
          }
          if (typeof window.Store.Msg.prototype.updateSeen === 'function') {
            window.Store.Msg.prototype.updateSeen = function () {};
          }
        }
      } catch {
        // ignore
      }
    }
  }

  function setupPrivacyModeObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList && (
            node.classList.contains('fnz6l7hl') ||
            node.classList.contains('g0rxnol7') ||
            node.classList.contains('l7jjieqr') ||
            node.classList.contains('ss0jdgcy') ||
            node.getAttribute('data-testid') === 'msg-read-receipts'
          )) {
            node.remove();
          }
          const checks = node.querySelectorAll?.('[data-testid="msg-check"], [data-testid="msg-dblcheck"], [data-testid="msg-dblcheck-ack"], .fnz6l7hl, .g0rxnol7, .l7jjieqr');
          checks.forEach((el) => {
            if (el.classList && (
              el.classList.contains('fnz6l7hl') ||
              el.classList.contains('g0rxnol7') ||
              el.classList.contains('l7jjieqr')
            )) {
              el.style.visibility = 'hidden';
            }
          });
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  async function init() {
    if (window.__lynSuperagenteReady) return;
    window.__lynSuperagenteReady = true;
    startRealtimeUpdates();
    observeWhatsappUnreadChats();

    let privacyObserver = null;
    let privacyMode = false;
    try {
      const data = await chrome.storage.local.get({ privacyMode: false });
      privacyMode = Boolean(data.privacyMode);
    } catch {
      privacyMode = false;
    }
    if (privacyMode) {
      applyPrivacyMode(true);
      privacyObserver = setupPrivacyModeObserver();
    }
    const privacyToggle = $('#lyn-privacy-mode');
    if (privacyToggle) {
      privacyToggle.checked = privacyMode;
      privacyToggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        await chrome.storage.local.set({ privacyMode: enabled });
        if (enabled) {
          applyPrivacyMode(true);
          if (!privacyObserver) privacyObserver = setupPrivacyModeObserver();
        } else {
          location.reload();
        }
      });
    }

    const ensureSidebar = () => {
      if (dom.sidebar) {
        loadSpecialists().catch(() => {});
        loadChats().catch(() => {});
        return true;
      }
      return false;
    };

    await waitForElement('#app', 20000).then(() => {
      createSidebar();
      ensureSidebar();
    }).catch(() => {
      let timeoutId;
      const observer = new MutationObserver(() => {
        if (ensureSidebar()) {
          observer.disconnect();
          clearTimeout(timeoutId);
        }
      });
      timeoutId = setTimeout(() => observer.disconnect(), 30000);
      observer.observe(document.body, { childList: true, subtree: true });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.chats) {
        state.chats = changes.chats.newValue || [];
        renderChatList();
      }
      if (changes.messages && state.selectedChatId) {
        state.messages = (changes.messages.newValue || {})[state.selectedChatId] || [];
        renderMessages();
      }
      if (changes.privacyMode !== undefined) {
        const enabled = Boolean(changes.privacyMode.newValue);
        document.body.classList.toggle('lyn-privacy-mode', enabled);
        if (enabled) {
          applyPrivacyMode(true);
        }
      }
      if (changes.extensionActivationId?.newValue && !realtimeSource) {
        startRealtimeUpdates();
      }
      if (changes.backendUrl && realtimeSource) {
        realtimeSource.close();
        realtimeSource = null;
        startRealtimeUpdates();
      }
    });
  }

  init().catch((error) => {
    console.error('[LYN] Init error:', error);
  });
})();
