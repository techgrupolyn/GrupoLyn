// Formato y estado en la URL de Netelip › Historial de llamadas. Fechas siempre en hora de Madrid.
const MADRID = 'Europe/Madrid';

const dateTimeFormat = new Intl.DateTimeFormat('es-ES', { timeZone: MADRID, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** 2026-11-15T08:47:00Z → «15/11/2026 09:47» */
export function formatMadridDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = Object.fromEntries(dateTimeFormat.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** Medianoche de Madrid del día «aaaa-mm-dd», en ISO UTC (para filtrar por fecha en el servidor). */
export function madridDayStartIso(day) {
  const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: MADRID, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return new Date(guess - (wall - guess)).toISOString();
}

/** Día siguiente a «aaaa-mm-dd» (el filtro «hasta» incluye el día entero). */
export function nextDay(day) {
  const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1)).toISOString().slice(0, 10);
}

/** 95 → «01:35» */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.trunc(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** +34600000101 → «+34 600 000 101». Otros países: E.164 sin cambios. */
export function formatPhone(value) {
  const phone = String(value || '');
  const spanish = phone.match(/^\+34(\d{3})(\d{3})(\d{3})$/);
  return spanish ? `+34 ${spanish[1]} ${spanish[2]} ${spanish[3]}` : phone || '—';
}

/** 12.4 s → «00:12» para las marcas de tiempo de la transcripción. */
export function formatOffset(seconds) {
  return formatDuration(Math.floor(Number(seconds) || 0));
}

export const DEFAULT_CALL_FILTERS = { dir: '', via: '', agent: '', contact: '', tr: '', period: '', from: '', to: '', sort: 'recent', q: '', page: 1, call: '' };
const FILTER_KEYS = Object.keys(DEFAULT_CALL_FILTERS);

export function readCallFilters(search = '') {
  const params = new URLSearchParams(search);
  const filters = { ...DEFAULT_CALL_FILTERS };
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null) filters[key] = key === 'page' ? Math.max(1, Math.trunc(Number(value)) || 1) : value;
  }
  return filters;
}

/** Escribe los filtros en la URL sin tocar el resto de parámetros (view, tab…). */
export function writeCallFilters(url, filters) {
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value === '' || value === null || value === undefined || value === DEFAULT_CALL_FILTERS[key]) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

export function clearCallFilters(url) {
  for (const key of FILTER_KEYS) url.searchParams.delete(key);
  return url;
}

/** Parámetros para GET /api/netelip/calls. */
export function callListQuery(filters, now = new Date()) {
  const params = new URLSearchParams({ page: String(filters.page || 1), page_size: '25' });
  if (filters.dir) params.set('direction', filters.dir);
  if (filters.via) params.set('via', filters.via);
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.contact) params.set('contact', filters.contact);
  if (filters.tr) params.set('transcription', filters.tr);
  if (filters.q) params.set('q', filters.q);
  if (filters.sort === 'oldest') params.set('sort', 'occurred_at_asc');
  else if (filters.sort === 'longest') params.set('sort', 'duration_desc');
  if (['7', '30', '90'].includes(String(filters.period))) params.set('from', new Date(now.getTime() - Number(filters.period) * 86400_000).toISOString());
  if (filters.period === 'custom') {
    if (filters.from) params.set('from', madridDayStartIso(filters.from));
    if (filters.to) params.set('to', madridDayStartIso(nextDay(filters.to)));
  }
  return params.toString();
}
