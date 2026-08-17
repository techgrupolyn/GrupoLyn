const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let err = new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json().catch(() => null);
}

async function requestMultipart(path, fields = {}, file) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  if (file) {
    form.append('file', file.blob || file, file.name || 'file');
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let err = new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json().catch(() => null);
}

export const api = {
  // Instance
  connectionState: () => request('/auth/status'),
  qr: () => request('/auth/qr'),
  setPresence: (presence, delay, number) => request('/instance/setPresence', { method: 'POST', body: JSON.stringify({ presence, delay, number }) }),
  logout: () => request('/instance/logout', { method: 'DELETE' }),
  deleteInstance: () => request('/instance/delete', { method: 'DELETE' }),
  restart: () => request('/instance/restart', { method: 'POST' }),
  profilePicture: (number) => request('/instance/profilePicture?number=' + encodeURIComponent(number)),

  // Auth
  authorize: (numero) => request('/auth/authorize', { method: 'POST', body: JSON.stringify({ numero }) }),

  // Chats
  chats: () => request('/chats'),
  messages: (chatId) => request(`/chats/${encodeURIComponent(chatId)}/mensajes`),
  messagesLatest: (chatId, since) => request(`/chats/${encodeURIComponent(chatId)}/mensajes/latest?since=${encodeURIComponent(since || '')}`),
  readChat: (chatId) => request(`/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST' }),
  archiveChat: (remoteJid, archive) => request('/chat/archive', { method: 'POST', body: JSON.stringify({ remoteJid, archive }) }),
  markUnread: (remoteJid) => request('/chat/markUnread', { method: 'POST', body: JSON.stringify({ remoteJid }) }),
  blockUser: (number, status) => request('/chat/block', { method: 'POST', body: JSON.stringify({ number, status }) }),
  privacySettings: () => request('/chat/privacy'),
  updatePrivacySettings: (body) => request('/chat/privacy', { method: 'POST', body: JSON.stringify(body) }),
  sendPresence: (number, presence, delay) => request('/chat/presence', { method: 'POST', body: JSON.stringify({ number, presence, delay }) }),
  whatsappNumbers: (numbers) => request('/chat/whatsappNumbers', { method: 'POST', body: JSON.stringify({ numbers }) }),
  searchMessages: (body) => request('/chat/searchMessages', { method: 'POST', body: JSON.stringify(body) }),
  clearMessages: (remoteJid) => request('/chat/clearMessages', { method: 'POST', body: JSON.stringify({ remoteJid }) }),
  pinChat: (remoteJid, pin) => request('/chat/pin', { method: 'POST', body: JSON.stringify({ remoteJid, pin }) }),
  muteChat: (remoteJid, expiration) => request('/chat/mute', { method: 'POST', body: JSON.stringify({ remoteJid, expiration }) }),
  deleteChat: (remoteJid) => request('/chat/delete', { method: 'POST', body: JSON.stringify({ remoteJid }) }),
  markMessageUnread: (remoteJid, messageId) => request('/chat/mark-unread', { method: 'POST', body: JSON.stringify({ remoteJid, messageId }) }),
  checkIsWhatsApp: (numbers) => request('/chat/checkIsWhatsApp', { method: 'POST', body: JSON.stringify({ numbers }) }),
  findContacts: (where) => request('/chat/findContacts', { method: 'POST', body: JSON.stringify(where || {}) }),
  chatStatusMessages: (remoteJid) => request(`/chat/statusMessage?remoteJid=${encodeURIComponent(remoteJid || '')}`),
  broadcasts: () => request('/chat/broadcasts'),

  // Calls
  callReject: (callId, remoteJid, reason) => request('/call/reject', { method: 'POST', body: JSON.stringify({ callId, remoteJid, reason }) }),
  callHistory: (remoteJid) => request(`/call/history?remoteJid=${encodeURIComponent(remoteJid || '')}`),

  // Profile privacy
  profilePrivacy: () => request('/profile/privacy'),
  updateProfilePrivacy: (body) => request('/profile/privacy', { method: 'POST', body: JSON.stringify(body) }),

  // Messages
  sendText: (chatId, texto) => request('/enviar', { method: 'POST', body: JSON.stringify({ chatId, texto }) }),
  sendMedia: (number, mediatype, media, mimetype, caption, fileName) => request('/message/sendMedia', { method: 'POST', body: JSON.stringify({ number, mediatype, media, mimetype, caption, fileName }) }),
  sendPtv: (number, video) => request('/message/sendPtv', { method: 'POST', body: JSON.stringify({ number, video }) }),
  sendAudio: (number, audio) => request('/message/sendAudio', { method: 'POST', body: JSON.stringify({ number, audio }) }),
  sendStatus: (type, content, statusJidList, allContacts, caption, backgroundColor, font) => request('/message/sendStatus', { method: 'POST', body: JSON.stringify({ type, content, statusJidList, allContacts, caption, backgroundColor, font }) }),
  sendSticker: (number, sticker) => request('/message/sendSticker', { method: 'POST', body: JSON.stringify({ number, sticker }) }),
  sendLocation: (number, latitude, longitude, name, address) => request('/message/sendLocation', { method: 'POST', body: JSON.stringify({ number, latitude, longitude, name, address }) }),
  sendContact: (number, contact) => request('/message/sendContact', { method: 'POST', body: JSON.stringify({ number, contact }) }),
  sendReaction: (key, reaction) => request('/message/sendReaction', { method: 'POST', body: JSON.stringify({ key, reaction }) }),
  sendPoll: (number, name, selectableCount, values, messageSecret) => request('/message/sendPoll', { method: 'POST', body: JSON.stringify({ number, name, selectableCount, values, messageSecret }) }),
  sendList: (number, title, description, footerText, buttonText, sections) => request('/message/sendList', { method: 'POST', body: JSON.stringify({ number, title, description, footerText, buttonText, sections }) }),
  sendButtons: (number, title, description, footer, buttons) => request('/message/sendButtons', { method: 'POST', body: JSON.stringify({ number, title, description, footer, buttons }) }),
  sendTemplate: (number, name, language, components) => request('/message/sendTemplate', { method: 'POST', body: JSON.stringify({ number, name, language, components }) }),
  updateMessage: (remoteJid, id, text) => request('/message/update', { method: 'POST', body: JSON.stringify({ remoteJid, id, text }) }),
  deleteMessage: (id, remoteJid, fromMe, participant) => request('/message/delete', { method: 'DELETE', body: JSON.stringify({ id, remoteJid, fromMe, participant }) }),
  mediaBase64: (messageId) => request(`/media/message/${encodeURIComponent(messageId)}/base64`),

  // Groups
  createGroup: (subject, participants, description, promoteParticipants) => request('/group/create', { method: 'POST', body: JSON.stringify({ subject, participants, description, promoteParticipants }) }),
  groups: () => request('/chats'),
  groupInfos: (groupJid) => request(`/group/infos?groupJid=${encodeURIComponent(groupJid)}`),
  groupParticipants: (groupJid) => request(`/group/participants?groupJid=${encodeURIComponent(groupJid)}`),
  groupMembers: (groupJid) => request(`/group/members?groupJid=${encodeURIComponent(groupJid)}`),
  groupInviteCode: (groupJid) => request(`/group/inviteCode?groupJid=${encodeURIComponent(groupJid)}`),
  groupInviteInfo: (inviteCode) => request(`/group/inviteInfo?inviteCode=${encodeURIComponent(inviteCode)}`),
  acceptGroupInvite: (inviteCode) => request('/group/acceptInvite', { method: 'POST', body: JSON.stringify({ inviteCode }) }),
  sendGroupInvite: (groupJid, description, numbers) => request('/group/sendInvite', { method: 'POST', body: JSON.stringify({ groupJid, description, numbers }) }),
  revokeGroupInvite: (groupJid) => request('/group/revokeInvite', { method: 'POST', body: JSON.stringify({ groupJid }) }),
  updateGroupSubject: (groupJid, subject) => request('/group/subject', { method: 'POST', body: JSON.stringify({ groupJid, subject }) }),
  updateGroupDescription: (groupJid, description) => request('/group/description', { method: 'POST', body: JSON.stringify({ groupJid, description }) }),
  updateGroupPicture: (groupJid, image) => request('/group/picture', { method: 'POST', body: JSON.stringify({ groupJid, image }) }),
  updateGroupParticipant: (groupJid, action, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action, participants }) }),
  addGroupParticipants: (groupJid, participants) => request('/group/addParticipants', { method: 'POST', body: JSON.stringify({ groupJid, participants }) }),
  removeGroupParticipants: (groupJid, participants) => request('/group/removeParticipants', { method: 'POST', body: JSON.stringify({ groupJid, participants }) }),
  promoteGroupParticipants: (groupJid, participants) => request('/group/promoteParticipants', { method: 'POST', body: JSON.stringify({ groupJid, participants }) }),
  demoteGroupParticipants: (groupJid, participants) => request('/group/demoteParticipants', { method: 'POST', body: JSON.stringify({ groupJid, participants }) }),
  updateGroupSetting: (groupJid, action) => request('/group/updateSetting', { method: 'POST', body: JSON.stringify({ groupJid, action }) }),
  toggleGroupEphemeral: (groupJid, expiration) => request('/group/toggleEphemeral', { method: 'POST', body: JSON.stringify({ groupJid, expiration }) }),
  leaveGroup: (groupJid) => request('/group/leave', { method: 'DELETE', body: JSON.stringify({ groupJid }) }),

  // Profile
  updateProfilePicture: (number, picture) => request('/profile/picture', { method: 'POST', body: JSON.stringify({ number, picture }) }),
  updateProfileName: (name) => request('/profile/name', { method: 'POST', body: JSON.stringify({ name }) }),
  updateProfileStatus: (status) => request('/profile/status', { method: 'POST', body: JSON.stringify({ status }) }),
  removeProfilePicture: () => request('/profile/picture', { method: 'DELETE' }),
  profileShow: (number) => request(`/profile/show?number=${encodeURIComponent(number || '')}`),
  profilePictureUrl: (number) => request(`/profile/picture?number=${encodeURIComponent(number || '')}`),

  // Templates
  templates: () => request('/templates'),
  createTemplate: (name, language, components, tipo) => request('/templates', { method: 'POST', body: JSON.stringify({ name, language, components, tipo }) }),
  updateTemplate: (id, name, language, components) => request(`/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, language, components }) }),
  deleteTemplate: (id) => request(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ id }) }),

  // Labels
  labels: () => request('/labels'),
  handleLabel: (body) => request('/labels/handle', { method: 'POST', body: JSON.stringify(body) }),

  // Business
  businessCatalog: (number) => request('/business/catalog', { method: 'POST', body: JSON.stringify({ number }) }),
  businessCollections: (number) => request('/business/collections', { method: 'POST', body: JSON.stringify({ number }) }),

  // Settings
  settings: () => request('/settings/find'),
  settingsSet: (body) => request('/settings/set', { method: 'POST', body: JSON.stringify(body) }),

  // Proxy
  proxySet: (body) => request('/proxy/set', { method: 'POST', body: JSON.stringify(body) }),
  proxyFind: () => request('/proxy/find'),

  // CEO
  ceoMetrics: () => request('/ceo/metrics'),
  ceoAsk: (pregunta) => request('/ceo/ask', { method: 'POST', body: JSON.stringify({ pregunta }) }),

  // MVP
  pendientes: (params = {}) => request(`/pendientes?${new URLSearchParams(params || {}).toString()}`),
  resumenPorRol: (params) => request(`/resumen/rol?${new URLSearchParams(params || {}).toString()}`),
  batchReply: (replies, intervalo_ms) => request('/batch/reply', { method: 'POST', body: JSON.stringify({ replies, intervalo_ms }) }),
  employeeByNumber: (numero) => request(`/empleados/por-numero?numero=${encodeURIComponent(numero || '')}`),

  // Backoffice
  roles: () => request('/roles'),
  createRole: (rol) => request('/roles', { method: 'POST', body: JSON.stringify(rol) }),
  employees: () => request('/empleados'),
  createEmployee: (emp) => request('/empleados', { method: 'POST', body: JSON.stringify(emp) }),
};

export default api;
