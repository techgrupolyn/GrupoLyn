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

  it('muestra un error de carga y recupera las cuentas al reintentar', async () => {
    api.whatsappAccounts.list.mockRejectedValueOnce(new Error('HTTP 504'));
    render(<WhatsAppSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 504');
    expect(screen.queryByText('No hay cuentas de WhatsApp registradas en este dashboard.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar cuentas' }));
    expect(await screen.findByRole('button', { name: 'Desvincular Ventas' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('mantiene las cuentas cargadas si una actualización falla', async () => {
    render(<WhatsAppSettingsPanel />);
    await screen.findByRole('button', { name: 'Desvincular Ventas' });
    api.whatsappAccounts.list.mockRejectedValueOnce(new Error('Red no disponible'));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar cuentas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Red no disponible');
    expect(screen.getByRole('button', { name: 'Desvincular Ventas' })).toBeEnabled();
  });

  it('distingue una lista vacía de un error', async () => {
    api.whatsappAccounts.list.mockResolvedValue([]);
    render(<WhatsAppSettingsPanel />);
    expect(await screen.findByText('No hay cuentas de WhatsApp registradas en este dashboard.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('no oculta respuestas inválidas como cuentas vacías', async () => {
    api.whatsappAccounts.list.mockResolvedValue({ error: 'unexpected' });
    render(<WhatsAppSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('lista de cuentas inválida');
  });

  it('indica la carga pendiente sin anunciar que no hay cuentas', async () => {
    let finish;
    api.whatsappAccounts.list.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<WhatsAppSettingsPanel />);
    expect(screen.getByRole('button', { name: 'Cargando cuentas…' })).toBeDisabled();
    expect(screen.queryByText('No hay cuentas de WhatsApp registradas en este dashboard.')).not.toBeInTheDocument();
    await act(async () => finish([]));
    expect(screen.getByRole('button', { name: 'Actualizar cuentas' })).toBeEnabled();
  });
});
