import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeetingRecording from '../src/ceo-dashboard/components/MeetingRecording';

const meeting = { id: 'meeting', recording_file_id: null, recording_status: 'pending' };
afterEach(() => vi.useRealTimers());
describe('Vídeo de la reunión', () => {
  it('abre el ID de Drive en otra pestaña sin copiar una URL del servidor', () => {
    render(<MeetingRecording meeting={{ ...meeting, recording_status: 'available', recording_file_id: 'video123456', recording_url: 'https://evil.test' }} />);
    const link = screen.getByRole('link', { name: 'Ver vídeo' });
    expect(link).toHaveAttribute('href', 'https://drive.google.com/file/d/video123456/view');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it.each([['pending', 'Grabación en proceso'], ['none', 'Sin grabación']])('muestra %s sin enlace', (status, text) => {
    render(<MeetingRecording meeting={{ ...meeting, recording_status: status }} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('no expone vídeo ni consulta cuando el acceso es parcial', () => {
    const load = vi.fn();
    render(<MeetingRecording meeting={{ ...meeting, partial_scope: true, recording_status: 'available', recording_file_id: 'video123456' }} loadRecording={load} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });
  it('actualiza una grabación tardía desde none y detiene el sondeo', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce({ recording_status: 'none' }).mockResolvedValue({ recording_status: 'available', recording_file_id: 'video123456' });
    render(<MeetingRecording meeting={meeting} loadRecording={load} />);
    await act(async () => {});
    expect(screen.getByText('Sin grabación')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByRole('link', { name: 'Ver vídeo' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('un error no muestra Sin grabación y no reutiliza respuestas de otra reunión', async () => {
    const load = vi.fn().mockRejectedValue(new Error('403'));
    render(<MeetingRecording meeting={{ ...meeting, recording_status: 'none' }} loadRecording={load} />);
    await waitFor(() => expect(screen.getByText('Grabación en proceso')).toBeInTheDocument());
  });
  it('descarta el resultado si se cambia la reunión y limpia el sondeo al cerrar', async () => {
    let finish;
    const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ recording_status: 'none' });
    const view = render(<MeetingRecording meeting={meeting} loadRecording={load} />);
    view.rerender(<MeetingRecording meeting={{ ...meeting, id: 'other' }} loadRecording={load} />);
    await waitFor(() => expect(screen.getByText('Sin grabación')).toBeInTheDocument());
    await act(async () => { finish({ recording_status: 'available', recording_file_id: 'wrong123456' }); });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    view.unmount();
  });
});
