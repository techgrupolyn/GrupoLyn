/**
 * Rol propio del superagente para personas de fuera (p. ej. una consultora o agencia de marketing). No existe en Club LYN:
 * se asigna a usuarios locales con `scripts/usuario-consultor.ts`. Ve Netelip › Historial de llamadas y todas las reuniones de
 * Gestión de reuniones, siempre en solo lectura, y nada más del Dashboard. Debe coincidir con frontend/src/ceo-dashboard/CeoLogin.jsx.
 */
export const ROL_CONSULTOR = 'consultor_lectura';

export function esConsultor(role: unknown): boolean {
  return String(role || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s/-]+/g, '_') === ROL_CONSULTOR;
}
