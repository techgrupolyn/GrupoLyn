import { describe, expect, it } from 'vitest';
import { CONSULTOR_VIEWS, normalizeSettingsTab, readDashboardRoute, shouldShowMeetingsMigrationNotice } from '../src/ceo-dashboard/routing';

describe('Rutas del Dashboard', () => {
  it('abre configuración general cuando no se recibe una pestaña', () => {
    expect(readDashboardRoute('?view=settings')).toEqual({ view: 'settings', settingsTab: 'general' });
  });

  it('conserva la pestaña solicitada de configuración', () => {
    expect(readDashboardRoute('?view=settings&tab=meetings')).toEqual({ view: 'settings', settingsTab: 'meetings' });
    expect(readDashboardRoute('?view=settings&tab=whatsapp')).toEqual({ view: 'settings', settingsTab: 'whatsapp' });
  });

  it('normaliza vistas y pestañas inválidas para evitar pantallas sin salida', () => {
    expect(readDashboardRoute('?view=desconocida&tab=otro')).toEqual({ view: 'dashboard', settingsTab: 'general' });
    expect(normalizeSettingsTab('INTEGRATIONS')).toBe('integrations');
  });

  it('mantiene el aviso de migración hasta que el usuario lo descarte', () => {
    expect(shouldShowMeetingsMigrationNotice(null)).toBe(true);
    expect(shouldShowMeetingsMigrationNotice('dismissed')).toBe(false);
  });

  it('fuerza el acceso público a consultas aunque la URL incluya otra vista', () => {
    expect(readDashboardRoute('?view=settings&tab=meetings', true)).toEqual({ view: 'ai', settingsTab: 'general' });
  });
});
describe('Consultor de solo lectura', () => {
  it('solo abre Netelip o reuniones; cualquier otra vista abre Netelip', () => {
    expect(CONSULTOR_VIEWS).toEqual(['netelip', 'meetings']);
    for (const search of ['', '?view=settings', '?view=dashboard', '?view=marketing', '?view=decisiones', '?view=work']) {
      expect(readDashboardRoute(search, false, true).view).toBe('netelip');
    }
    expect(readDashboardRoute('?view=meetings', false, true)).toEqual({ view: 'meetings', settingsTab: 'general' });
  });
});
