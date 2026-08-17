import { parseActivationCode } from '../lib/invitation.js';

function $(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['backendUrl', 'activationLabel']);
  if (data.backendUrl) $('backendUrl').value = data.backendUrl;
  if (data.activationLabel) $('activationStatus').textContent = `Activada: ${data.activationLabel}`;
}

function isValidBackendUrl(value) {
  try {
    const url = new URL(value);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLocal);
  } catch {
    return false;
  }
}

function setStatus(id, message, isError = false) {
  const status = $(id);
  status.className = isError ? 'error' : 'status';
  status.textContent = message;
}

async function activateExtension() {
  const parsed = parseActivationCode($('activationCode').value);
  if (!parsed) {
    setStatus('activationStatus', 'El código no es válido.', true);
    return;
  }

  try {
    setStatus('activationStatus', 'Validando código...');
    const response = await fetch(`${parsed.backendUrl}/api/extension/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: parsed.code }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.backend_url) throw new Error(data.error || 'No se pudo activar la extensión');

    await chrome.storage.local.set({
      backendUrl: data.backend_url,
      extensionActivationId: data.activation_id || '',
      activationLabel: data.label || 'Cuenta vinculada',
      defaultSpecialistId: '',
      chats: [],
      messages: {},
    });
    $('backendUrl').value = data.backend_url;
    $('activationCode').value = '';
    setStatus('activationStatus', 'Activada. Abrí el panel lateral y escaneá el código QR.');
  } catch (error) {
    setStatus('activationStatus', `Error: ${error.message || error}`, true);
  }
}

async function saveSettings() {
  const backendUrl = $('backendUrl').value.trim();
  if (!backendUrl) {
    setStatus('status', 'Completá la URL del backend', true);
    return;
  }
  if (!isValidBackendUrl(backendUrl)) {
    setStatus('status', 'Usa HTTPS para servidores remotos; HTTP solo se permite en localhost.', true);
    return;
  }

  try {
    await chrome.storage.local.set({ backendUrl });
    setStatus('status', 'Guardado');
  } catch (error) {
    setStatus('status', `Error: ${error.message || error}`, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  $('activate').addEventListener('click', activateExtension);
  $('save').addEventListener('click', saveSettings);
});