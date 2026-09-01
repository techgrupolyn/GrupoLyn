const BASE = '/api';

async function request(path, options = {}) {
  const token = localStorage.getItem('ceo_token');
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || (res.status === 403 && /No tienes permisos para esta operación/i.test(text))) {
      localStorage.removeItem('lyn_ceo_user');
      localStorage.removeItem('ceo_token');
      window.location.assign('/?view=ceo');
    }
    let err = new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json().catch(() => null);
}

export const api = {
  metrics: () => request('/ceo/metrics'),
  chats: () => request('/chats'),
  ceoChats: () => request('/ceo/chats'),
  messages: (chatId) => request(`/chats/${encodeURIComponent(chatId)}/mensajes`),
  sendText: (chatId, texto) => request('/enviar', { method: 'POST', body: JSON.stringify({ chatId, texto }) }),
  askAI: (pregunta) => request('/ceo/ask', { method: 'POST', body: JSON.stringify({ pregunta }) }),
  roles: () => request('/roles'),
  createRole: (rol) => request('/roles', { method: 'POST', body: JSON.stringify(rol) }),
  employees: () => request('/empleados'),
  createEmployee: (emp) => request('/empleados', { method: 'POST', body: JSON.stringify(emp) }),
  directory: {
    overview: () => request('/directory'),
    syncStatus: () => request('/directory/sync/status'),
    sync: () => request('/directory/sync', { method: 'POST' }),
    addProjectAlias: (projectId, alias) => request(`/directory/projects/${encodeURIComponent(projectId)}/aliases`, { method: 'POST', body: JSON.stringify({ alias }) }),
    removeProjectAlias: (projectId, aliasId) => request(`/directory/projects/${encodeURIComponent(projectId)}/aliases/${encodeURIComponent(aliasId)}`, { method: 'DELETE' }),
  },
  groupMembers: (groupJid) => request(`/group/participants?groupJid=${encodeURIComponent(groupJid)}`),
  groupInfos: (groupJid) => request(`/group/infos?groupJid=${encodeURIComponent(groupJid)}`),
  groupInviteCode: (groupJid) => request(`/group/inviteCode?groupJid=${encodeURIComponent(groupJid)}`),
  groupInviteInfo: (inviteCode) => request(`/group/inviteInfo?inviteCode=${encodeURIComponent(inviteCode)}`),
  createGroup: (subject, participants, description, promoteParticipants) => request('/group/create', { method: 'POST', body: JSON.stringify({ subject, participants, description, promoteParticipants }) }),
  sendGroupInvite: (groupJid, description, numbers) => request('/group/sendInvite', { method: 'POST', body: JSON.stringify({ groupJid, description, numbers }) }),
  addGroupParticipants: (groupJid, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action: 'add', participants }) }),
  removeGroupParticipants: (groupJid, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action: 'remove', participants }) }),
  promoteGroupParticipants: (groupJid, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action: 'promote', participants }) }),
  demoteGroupParticipants: (groupJid, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action: 'demote', participants }) }),
  groups: {
    infos: (groupJid) => request(`/group/infos?groupJid=${encodeURIComponent(groupJid)}`),
    participants: (groupJid) => request(`/group/participants?groupJid=${encodeURIComponent(groupJid)}`),
    inviteCode: (groupJid) => request(`/group/inviteCode?groupJid=${encodeURIComponent(groupJid)}`),
    inviteInfo: (inviteCode) => request(`/group/inviteInfo?inviteCode=${encodeURIComponent(inviteCode)}`),
    create: (subject, participants, description, promoteParticipants) => request('/group/create', { method: 'POST', body: JSON.stringify({ subject, participants, description, promoteParticipants }) }),
    subject: (groupJid, subject) => request('/group/subject', { method: 'POST', body: JSON.stringify({ groupJid, subject }) }),
    description: (groupJid, description) => request('/group/description', { method: 'POST', body: JSON.stringify({ groupJid, description }) }),
    picture: (groupJid, image) => request('/group/picture', { method: 'POST', body: JSON.stringify({ groupJid, image }) }),
    invite: (groupJid, description, numbers) => request('/group/sendInvite', { method: 'POST', body: JSON.stringify({ groupJid, description, numbers }) }),
    revokeInvite: (groupJid) => request('/group/revokeInvite', { method: 'POST', body: JSON.stringify({ groupJid }) }),
    updateParticipant: (groupJid, action, participants) => request('/group/updateParticipant', { method: 'POST', body: JSON.stringify({ groupJid, action, participants }) }),
    updateSetting: (groupJid, action) => request('/group/updateSetting', { method: 'POST', body: JSON.stringify({ groupJid, action }) }),
    toggleEphemeral: (groupJid, expiration) => request('/group/toggleEphemeral', { method: 'POST', body: JSON.stringify({ groupJid, expiration }) }),
    leave: (groupJid) => request('/group/leave', { method: 'DELETE', body: JSON.stringify({ groupJid }) }),
  },
  specialists: {
    list: () => request('/specialists'),
    get: (id) => request(`/specialists/${encodeURIComponent(id)}`),
    update: (id, body) => request(`/specialists/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  },
  chat: {
    privacySettings: () => request('/chat/privacy'),
    sendPresence: (number, presence, delay) => request('/chat/presence', { method: 'POST', body: JSON.stringify({ number, presence, delay }) }),
  },
  labels: {
    list: () => request('/labels'),
    handle: (body) => request('/labels/handle', { method: 'POST', body: JSON.stringify(body) }),
  },
  templates: {
    list: () => request('/templates'),
    create: (name, language, components, tipo = 'template') => request('/templates', { method: 'POST', body: JSON.stringify({ name, language, components, tipo }) }),
    update: (id, name, language, components) => request(`/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, language, components }) }),
    delete: (id) => request(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ id }) }),
  },
  business: {
    catalog: (number) => request('/business/catalog', { method: 'POST', body: JSON.stringify({ number }) }),
    collections: (number) => request('/business/collections', { method: 'POST', body: JSON.stringify({ number }) }),
  },
  settings: {
    find: () => request('/settings/find'),
    set: (body) => request('/settings/set', { method: 'POST', body: JSON.stringify(body) }),
  },
  proxySet: (body) => request('/proxy/set', { method: 'POST', body: JSON.stringify(body) }),
  whatsappAccounts: {
    list: () => request('/whatsapp-accounts'),
    create: (payload) => request('/whatsapp-accounts', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id, payload) => request(/whatsapp-accounts/, { method: 'PATCH', body: JSON.stringify(payload) }),
  },
  meetings: {
    list: ({ page = 1, pageSize = 25, q = '', filter = 'all', dateFrom = '', dateTo = '', recentDays = '', sort = 'recent', projectId = '', pmcEmployeeId = '', contactId = '' } = {}) => {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), filter, sort });
      if (q) params.set('q', q);
      if (projectId) params.set('project_id', projectId);
      if (pmcEmployeeId) params.set('pmc_employee_id', pmcEmployeeId);
      if (contactId) params.set('contact_id', contactId);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (recentDays) params.set('recent_days', String(recentDays));
      return request(`/meetings?${params.toString()}`);
    },
    get: (artifactId) => request(`/meetings/${encodeURIComponent(artifactId)}`),
    update: (artifactId, payload) => request(`/meetings/${encodeURIComponent(artifactId)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    analyze: (artifactId) => request(`/meetings/${encodeURIComponent(artifactId)}/analyze`, { method: 'POST' }),
    retag: () => request('/meetings/retag', { method: 'POST' }),
    addAction: (artifactId, payload) => request(`/meetings/${encodeURIComponent(artifactId)}/actions`, { method: 'POST', body: JSON.stringify(payload) }),
    updateAction: (artifactId, actionId, payload) => request(`/meetings/${encodeURIComponent(artifactId)}/actions/${encodeURIComponent(actionId)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    deleteAction: (artifactId, actionId) => request(`/meetings/${encodeURIComponent(artifactId)}/actions/${encodeURIComponent(actionId)}`, { method: 'DELETE' }),
    workflow: (artifactId, command, reason = '') => request(`/meetings/${encodeURIComponent(artifactId)}/workflow`, { method: 'POST', body: JSON.stringify({ command, reason }) }),
  },
  googleDrive: {
    status: () => request('/google-drive/status'),
    connect: () => request('/google-drive/connect', { method: 'POST' }),
    addFolder: (payload) => request('/google-drive/folders', { method: 'POST', body: JSON.stringify(payload) }),
    removeFolder: (id) => request(`/google-drive/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    syncFolder: (id) => request(`/google-drive/folders/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
    artifacts: (folderId = '') => request(`/google-drive/artifacts${folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''}`),
    artifact: (id) => request(`/google-drive/artifacts/${encodeURIComponent(id)}`),
  },
  extensionInvitations: {
    list: () => request('/extension/invitations'),
    create: (label, accountId, expiresInHours = 24) => request('/extension/invitations', { method: 'POST', body: JSON.stringify({ label, account_id: accountId, expires_in_hours: expiresInHours }) }),
    revoke: (id) => request(`/extension/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  profile: {
    picture: (number, picture) => request('/profile/picture', { method: 'POST', body: JSON.stringify({ number, picture }) }),
    name: (name) => request('/profile/name', { method: 'POST', body: JSON.stringify({ name }) }),
    status: (status) => request('/profile/status', { method: 'POST', body: JSON.stringify({ status }) }),
    removePicture: () => request('/profile/picture', { method: 'DELETE' }),
  },
};

export default api;
