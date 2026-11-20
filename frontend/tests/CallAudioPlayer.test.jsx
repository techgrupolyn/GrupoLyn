import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { netelip: { audio: vi.fn() } } }));

import api from '../src/ceo-dashboard/api';
import CallAudioPlayer, { audioUnavailableReason } from '../src/ceo-dashboard/views/CallAudioPlayer';

const grabada = { id: 7, via: 'phone', recorded: true };

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:local/audio-7');
  URL.revokeObjectURL = vi.fn();
  // jsdom no reproduce audio.
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Netelip · reproducir el audio de la llamada', () => {
  it('pide el audio con la sesión y lo reproduce con controles desde una URL blob: local', async () => {
    vi.mocked(api.netelip.audio).mockResolvedValue(new Blob(['mp3'], { type: 'audio/mpeg' }));
    render(<CallAudioPlayer call={grabada} transcriptionAccess="granted" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir audio' }));
    const audio = await screen.findByLabelText('Audio de la llamada');
    expect(api.netelip.audio).toHaveBeenCalledWith(7);
    expect(audio).toHaveAttribute('src', 'blob:local/audio-7');
    expect(audio).toHaveAttribute('controls');
  });

  it('al cerrar la ventana o abrir otra llamada se detiene el audio y se libera la URL', async () => {
    vi.mocked(api.netelip.audio).mockResolvedValue(new Blob(['mp3']));
    const { unmount } = render(<CallAudioPlayer call={grabada} transcriptionAccess="granted" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir audio' }));
    await screen.findByLabelText('Audio de la llamada');
    unmount();
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local/audio-7');
  });

  it('sin grabación o sin permiso, el botón está deshabilitado y dice por qué', () => {
    const { rerender } = render(<CallAudioPlayer call={{ ...grabada, recorded: false }} transcriptionAccess="granted" />);
    expect(screen.getByRole('button', { name: 'Reproducir audio' })).toBeDisabled();
    expect(screen.getByText('Grabación no disponible')).toBeInTheDocument();
    rerender(<CallAudioPlayer call={grabada} transcriptionAccess="denied" />);
    expect(screen.getByRole('button', { name: 'Reproducir audio' })).toBeDisabled();
    expect(api.netelip.audio).not.toHaveBeenCalled();
    expect(audioUnavailableReason({ ...grabada, via: 'whatsapp' }, 'granted')).toBe('Grabación no disponible');
    expect(audioUnavailableReason(grabada, 'granted')).toBeNull();
  });

  it('si el servidor dice que no hay grabación, lo muestra; si falla, invita a reintentar', async () => {
    vi.mocked(api.netelip.audio).mockRejectedValueOnce(Object.assign(new Error('HTTP 404'), { status: 404 }));
    render(<CallAudioPlayer call={grabada} transcriptionAccess="granted" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir audio' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Grabación no disponible.');
    vi.mocked(api.netelip.audio).mockRejectedValueOnce(Object.assign(new Error('HTTP 502'), { status: 502 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir audio' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar la grabación. Vuelve a intentarlo.'));
  });
});
