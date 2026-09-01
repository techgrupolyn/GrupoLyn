import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importWithChunkRecovery } from '../src/chunkRecovery';

describe('importWithChunkRecovery', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('returns a dynamically imported module without reloading', async () => {
    const replace = vi.fn();
    const module = { default: 'Dashboard' };

    await expect(importWithChunkRecovery(() => Promise.resolve(module), { replace })).resolves.toBe(module);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not reload when the imported application itself throws', async () => {
    const replace = vi.fn();

    await expect(importWithChunkRecovery(() => Promise.reject(new Error('ReferenceError: variable is not defined')), { replace })).rejects.toThrow('variable is not defined');
    expect(replace).not.toHaveBeenCalled();
  });
  it('reloads once with a cache-busting URL when a prior bundle is unavailable', async () => {
    const replace = vi.fn();
    const pending = importWithChunkRecovery(
      () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
      { currentUrl: 'https://ceo.grupolyn.com/?view=ceo', replace, now: () => 42 },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replace).toHaveBeenCalledWith('https://ceo.grupolyn.com/?view=ceo&_chunk_retry=42');

    await expect(importWithChunkRecovery(() => Promise.reject(new Error('still missing')), { replace })).rejects.toThrow('still missing');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(pending).toBeInstanceOf(Promise);
  });
});