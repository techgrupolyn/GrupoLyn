import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CeoLogin, hasUsableCeoToken, initialDashboardView, isCeoView, shouldPollWhatsappConnection, shouldShowCeoDashboard, shouldShowCeoLogin } from '../src/ceo-dashboard/CeoLogin';

describe('Acceso del panel CEO', () => {
  it('muestra el dashboard solo con sesión CEO y sin depender de WhatsApp', () => {
    expect(shouldShowCeoDashboard('ceo', { usuario: 'superadmin' })).toBe(true);
    expect(shouldShowCeoLogin('ceo', { usuario: 'superadmin' })).toBe(false);
  });

  it('opens the CEO login by default on the CEO subdomain', () => {
    expect(initialDashboardView('', 'ceo.grupolyn.com')).toBe('ceo');
    expect(initialDashboardView('?view=settings', 'ceo.grupolyn.com')).toBe('settings');
    expect(initialDashboardView('', '127.0.0.1')).toBe('home');
  });
  it('never polls the WhatsApp QR flow from CEO views', () => {
    expect(shouldPollWhatsappConnection('ceo', false)).toBe(false);
    expect(shouldPollWhatsappConnection('settings', false)).toBe(false);
    expect(shouldPollWhatsappConnection('home', false)).toBe(true);
  });
  it('reconoce las subrutas internas del CEO y nunca las deriva al QR', () => {
    expect(isCeoView('settings')).toBe(true);
    expect(isCeoView('specialists')).toBe(true);
    expect(shouldShowCeoLogin('settings', null)).toBe(true);
    expect(shouldShowCeoDashboard('settings', { usuario: 'superadmin' })).toBe(true);
  });
  it('muestra el login solo para la vista CEO sin sesión', () => {
    expect(shouldShowCeoLogin('ceo', null)).toBe(true);
    expect(shouldShowCeoDashboard('ceo', null)).toBe(false);
    expect(shouldShowCeoLogin('default', null)).toBe(false);
  });

  it('no revela credenciales iniciales y conserva el formulario de acceso', () => {
    render(<CeoLogin onSubmit={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Usuario')).toBeRequired();
    expect(screen.getByPlaceholderText('Contraseña')).toBeRequired();
    expect(screen.queryByText(/superadmin/i)).not.toBeInTheDocument();
  });

  it('descarta tokens CEO vencidos o malformados', () => {
    const valid = `${btoa(JSON.stringify({ exp: Date.now() + 60_000 }))}.firma`;
    const expired = `${btoa(JSON.stringify({ exp: Date.now() - 60_000 }))}.firma`;

    expect(hasUsableCeoToken(valid)).toBe(true);
    expect(hasUsableCeoToken(expired)).toBe(false);
    expect(hasUsableCeoToken('token-invalido')).toBe(false);
  });});