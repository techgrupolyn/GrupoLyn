import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProtocolosView from '../src/ceo-dashboard/views/ProtocolosView';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { protocols: { status: vi.fn() } } }));
vi.mock('../src/ceo-dashboard/views/ProtocolosAdminPanel', () => ({ default: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('vigencia del corpus de protocolos', () => {
  it('muestra versión y avisa cuando la última sincronización correcta supera 24 horas', async () => {
    const lastSyncedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    api.protocols.status.mockResolvedValue({ enabled: true, versionId: '1234567890abcdef', updatedAt: new Date().toISOString(), lastSyncedAt, fileCount: 7 });
    render(<ProtocolosView />);
    expect(await screen.findByText('1234567890ab')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('puede estar desactualizada');
    expect(screen.getByText(/Última sincronización correcta/u)).toBeTruthy();
  });

  it('no confunde la creación del corpus con una sincronización reciente', async () => {
    api.protocols.status.mockResolvedValue({ enabled: true, versionId: '1234567890abcdef', updatedAt: new Date().toISOString(), lastSyncedAt: null, fileCount: 7 });
    render(<ProtocolosView />);
    expect(await screen.findByText(/sin confirmar/u)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('puede estar desactualizada');
  });

  it('no muestra advertencia si la sincronización correcta es reciente', async () => {
    api.protocols.status.mockResolvedValue({ enabled: true, versionId: '1234567890abcdef', lastSyncedAt: new Date().toISOString(), fileCount: 7 });
    render(<ProtocolosView />);
    expect(await screen.findByText('1234567890ab')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
