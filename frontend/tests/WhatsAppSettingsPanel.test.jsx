import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppSettingsPanel } from '../src/ceo-dashboard/views/SettingsView';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  settings: { find: vi.fn() }, chat: { privacySettings: vi.fn() },
  extensionInvitations: { list: vi.fn() },
  whatsappAccounts: { list: vi.fn(), create: vi.fn(), disconnect: vi.fn() },
} }));

describe('Desvincular cuentas de WhatsApp', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.settings.find.mockResolvedValue({});
    api.chat.privacySettings.mockResolvedValue({});
    api.extensionInvitations.list.mockResolvedValue([]);
    api.whatsappAccounts.list.mockResolvedValue([
      { id: 'ventas', nombre: 'Ventas', evolution_instance_name: 'instancia-ventas', activo: true },
      { id: 'direccion', nombre: 'Dirección', evolution_instance_name: 'instancia-direccion', activo: true },
    ]);
    api.whatsappAccounts.disconnect.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('confirma la cuenta, conserva el historial y no envía el formulario de alta', async () => {
    render(<WhatsAppSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Ventas' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Ventas'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('se conservarán'));
    await waitFor(() => expect(api.whatsappAccounts.disconnect).toHaveBeenCalledExactlyOnceWith('ventas'));
    expect(await screen.findByRole('status')).toHaveTextContent('Cuenta «Ventas» desvinculada');
    expect(screen.getByText('Dirección')).toBeInTheDocument();
    expect(api.whatsappAccounts.create).not.toHaveBeenCalled();
  });

  it('cancelar no llama al backend', async () => {
    window.confirm.mockReturnValue(false);
    render(<WhatsAppSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Ventas' }));
    expect(api.whatsappAccounts.disconnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('bloquea doble envío y otras cuentas mientras espera', async () => {
    let finish;
    api.whatsappAccounts.disconnect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<WhatsAppSettingsPanel />);
    const button = await screen.findByRole('button', { name: 'Desvincular Ventas' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Desvinculando');
    expect(screen.getByRole('button', { name: 'Desvincular Dirección' })).toBeDisabled();
    fireEvent.click(button);
    expect(api.whatsappAccounts.disconnect).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(button).toBeEnabled();
  });

  it('muestra el fallo sin anunciar éxito y permite reintentar', async () => {
    api.whatsappAccounts.disconnect.mockRejectedValue(new Error('Evolution no disponible'));
    render(<WhatsAppSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desvincular Dirección' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Evolution no disponible');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desvincular Dirección' })).toBeEnabled();
  });
});
