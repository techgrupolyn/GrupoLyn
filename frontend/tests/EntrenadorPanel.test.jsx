import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: { netelip: { trainer: vi.fn(), updateTrainer: vi.fn(), publishTrainer: vi.fn(), trainerDocx: vi.fn() } },
}));

import api from '../src/ceo-dashboard/api';
import EntrenadorPanel from '../src/ceo-dashboard/views/EntrenadorPanel';

const v0 = { numero: 0, estado: 'lista', periodo_desde: null, periodo_hasta: null, llamadas: 0, resumen: 'Documento original de Jean Parra (05/11/2026).', objeciones: 0, arquetipos: 0, frases: 0, creado_en: '2026-11-08T10:00:00Z', terminado_en: '2026-11-08T10:00:00Z' };
const v1 = { numero: 1, estado: 'lista', periodo_desde: null, periodo_hasta: '2026-11-08T17:00:00Z', llamadas: 12, resumen: 'Aparecen asesores propios.', objeciones: 3, arquetipos: 2, frases: 0, autor_nombre: 'Ernesto', creado_en: '2026-11-08T17:00:00Z', terminado_en: '2026-11-08T17:02:00Z', drive_publicado_en: '2026-11-08T17:02:00Z', drive_url: 'https://drive.google.com/file/d/F1/view' };
const state = (extra = {}) => ({
  vigente: v0, publicado: null, en_curso: null, llamadas_pendientes: 12, versiones: [v0],
  can_update: true, modelo_configurado: true, drive_configurado: true, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.netelip.trainer).mockResolvedValue(state());
});

describe('EntrenadorPanel', () => {
  it('muestra la versión vigente, las llamadas nuevas y actualiza al pulsar el botón', async () => {
    vi.mocked(api.netelip.updateTrainer).mockResolvedValue({ id: '2', numero: 1, llamadas: 12 });
    render(<EntrenadorPanel />);
    const button = await screen.findByRole('button', { name: 'Actualizar con 12 llamadas nuevas' });
    expect(screen.getByText('Documento original de Jean, sin llamadas')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(api.netelip.updateTrainer).toHaveBeenCalledTimes(1));
    expect(api.netelip.trainer).toHaveBeenCalledTimes(2);
  });

  it('sin llamadas nuevas el botón está desactivado y explica por qué', async () => {
    vi.mocked(api.netelip.trainer).mockResolvedValue(state({ llamadas_pendientes: 0 }));
    render(<EntrenadorPanel />);
    expect(await screen.findByRole('button', { name: 'Actualizar con 0 llamadas nuevas' })).toBeDisabled();
    expect(screen.getByText('No hay llamadas evaluadas nuevas desde la última actualización.')).toBeInTheDocument();
  });

  it('quien no es supervisor ve el documento pero no puede actualizarlo', async () => {
    vi.mocked(api.netelip.trainer).mockResolvedValue(state({ can_update: false }));
    render(<EntrenadorPanel />);
    expect(await screen.findByRole('button', { name: /Actualizar con/ })).toBeDisabled();
    expect(screen.getByText('Solo los supervisores pueden actualizar el documento.')).toBeInTheDocument();
  });

  it('con una actualización en curso lo indica y desactiva el botón', async () => {
    vi.mocked(api.netelip.trainer).mockResolvedValue(state({ en_curso: { numero: 1, llamadas: 12 }, versiones: [{ ...v1, estado: 'procesando', drive_publicado_en: null }, v0] }));
    render(<EntrenadorPanel />);
    expect(await screen.findByRole('button', { name: 'Actualizando…' })).toBeDisabled();
    expect(screen.getByText(/Analizando 12 llamadas con Gemini/)).toBeInTheDocument();
  });

  it('enlaza el documento de Drive y avisa si quedó fuera de la carpeta', async () => {
    vi.mocked(api.netelip.trainer).mockResolvedValue(state({ vigente: v1, versiones: [v1, v0], llamadas_pendientes: 0, publicado: { numero: 1, drive_url: v1.drive_url, drive_en_carpeta: false, drive_publicado_en: v1.drive_publicado_en } }));
    render(<EntrenadorPanel />);
    expect(await screen.findByRole('link', { name: 'Abrir el documento ↗' })).toHaveAttribute('href', v1.drive_url);
    expect(screen.getByText(/Muévelo una vez a la carpeta/)).toBeInTheDocument();
    expect(screen.getByText('3 objeciones · 2 arquetipos')).toBeInTheDocument();
  });

  it('si la última actualización falló, lo explica y deja el documento vigente', async () => {
    vi.mocked(api.netelip.trainer).mockResolvedValue(state({ versiones: [{ ...v1, estado: 'error', error: 'Gemini respondió HTTP 503' }, v0] }));
    render(<EntrenadorPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('La última actualización (v1) falló: Gemini respondió HTTP 503.');
  });
});
