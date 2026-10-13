import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWithDeadline } from '../request-deadline.ts';

afterEach(() => vi.useRealTimers());

describe('requestWithDeadline', () => {
  it('rechaza aunque la petición ignore la cancelación', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const pending = requestWithDeadline((signal) => {
      requestSignal = signal;
      return new Promise(() => undefined);
    }, 100);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('devuelve el resultado y libera el temporizador', async () => {
    vi.useFakeTimers();
    await expect(requestWithDeadline(async () => 'ok', 100)).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propaga errores síncronos y libera el temporizador', async () => {
    vi.useFakeTimers();
    await expect(requestWithDeadline(() => { throw new Error('fallo'); }, 100)).rejects.toThrow('fallo');
    expect(vi.getTimerCount()).toBe(0);
  });
});
