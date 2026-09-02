export const CEO_DASHBOARD_VIEWS = new Set([
  'dashboard', 'ai', 'groups', 'labels', 'templates', 'business', 'meetings', 'settings', 'specialists', 'backoffice',
]);

export const SETTINGS_TABS = [
  { key: 'general', label: 'General', description: 'Preferencias generales del portal y acceso a los ajustes por agente.' },
  { key: 'whatsapp', label: 'WhatsApp', description: 'Instancia Evolution, cuentas, presencia, proxy y activaciones.' },
  { key: 'meetings', label: 'Agente de reuniones', description: 'Google Drive y carpetas fuente.' },
  { key: 'router', label: 'Router de agentes', description: 'Reglas de enrutamiento entre fuentes, agentes y resultados.' },
  { key: 'integrations', label: 'Integraciones', description: 'Estado y credenciales de las fuentes externas conectadas.' },
];

export const SETTINGS_TAB_KEYS = new Set(SETTINGS_TABS.map((item) => item.key));

export function normalizeSettingsTab(tab) {
  const value = String(tab || '').toLowerCase();
  return SETTINGS_TAB_KEYS.has(value) ? value : 'general';
}

export function readDashboardRoute(search = '', consultationOnly = false) {
  const params = new URLSearchParams(search);
  if (consultationOnly) return { view: 'ai', settingsTab: 'general' };
  const requestedView = String(params.get('view') || 'dashboard').toLowerCase();
  return {
    view: CEO_DASHBOARD_VIEWS.has(requestedView) ? requestedView : 'dashboard',
    settingsTab: normalizeSettingsTab(params.get('tab')),
  };
}

export function shouldShowMeetingsMigrationNotice(value) {
  return value !== 'dismissed';
}