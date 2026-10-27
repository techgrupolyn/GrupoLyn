import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useVisiblePolling from '../src/ceo-dashboard/useVisiblePolling';

describe('actualización visible del dashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('no solapa peticiones lentas y vuelve a consultar después de completarlas', async () => {
    let finish;
    const task = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    renderHook(() => useVisiblePolling(task, 15_000, true, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(task).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('pausa pestañas ocultas y actualiza al regresar sin esperar al intervalo', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useVisiblePolling(task, 15_000, true, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(task).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('invalida respuestas tras desmontarse y elimina el temporizador y listener', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useVisiblePolling(task, 15_000, true, true));
    const isCurrent = task.mock.calls[0][0];
    expect(isCurrent()).toBe(true);
    unmount();
    expect(isCurrent()).toBe(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('continúa después de errores y no consulta cuando está deshabilitado', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValue(undefined);
    const { rerender } = renderHook(({ enabled }) => useVisiblePolling(task, 15_000, enabled, true), { initialProps: { enabled: false } });
    expect(task).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(task).toHaveBeenCalledTimes(3);
  });
});
