import { parseActivationCode } from '../lib/invitation.js';

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, isError = false) {
  const status = $('activationStatus');
  status.className = isError ? 'error' : 'status';
  status.textContent = message;
}

function updateActivationButton() {
  $('activate').disabled = !$('privacyAccepted').checked;
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['activationLabel', 'privacyAccepted']);
  $('privacyAccepted').checked = Boolean(data.privacyAccepted);
  updateActivationButton();
  if (data.activationLabel) setStatus(`Activada: ${data.activationLabel}`);
}

async function activateExtension() {
  if (!$('privacyAccepted').checked) {
    setStatus('Debés aceptar la política de privacidad para activar la extensión.', true);
    return;
  }

  const parsed = parseActivationCode($('activationCode').value);
  if (!parsed) {
    setStatus('El código no es válido.', true);
    return;
  }

  try {
    setStatus('Validando código...');
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
      privacyAccepted: true,
      defaultSpecialistId: '',
      chats: [],
      messages: {},
    });
    $('activationCode').value = '';
    setStatus('Activada. Abrí el panel lateral y escaneá el QR de tu cuenta WhatsApp.');
  } catch (error) {
    setStatus(`Error: ${error.message || error}`, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  $('activate').addEventListener('click', activateExtension);
  $('privacyAccepted').addEventListener('change', updateActivationButton);
});