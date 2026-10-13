import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginClubSso } from '../src/ceo-dashboard/club-sso';

const clubOrigin = 'http://localhost:8080';
const state = 'a'.repeat(32);
const stops = [];
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });

function setup(response = { ok: true, json: async () => ({ usuario: { id: 7, rol: 'employee:pmc' }, token: 'local-session' }) }) {
  let listener;
  const opener = { postMessage: vi.fn() };
  const host = {
    opener,
    location: { search: `?club_sso=1&state=${state}`, replace: vi.fn() },
    localStorage: { setItem: vi.fn() },
    addEventListener: vi.fn((_name, handler) => { listener = handler; }),
    removeEventListener: vi.fn(),
  };
  const fetcher = vi.fn(async () => response);
  const onError = vi.fn();
  stops.push(beginClubSso({ host, clubOrigin, onError, fetcher, cryptoApi: webcrypto }));
  const receive = (overrides = {}) => listener({ origin: clubOrigin, source: opener, data: { state, type: 'lyn-club-sso-code', code: 'c'.repeat(43) }, ...overrides });
  return { host, opener, fetcher, onError, receive };
}

describe('Dashboard Club LYN handoff', () => {
  it('sends only a challenge to Club and exchanges the code with a private verifier', async () => {
    const test = setup();
    await vi.waitFor(() => expect(test.opener.postMessage).toHaveBeenCalled());
    const ready = test.opener.postMessage.mock.calls[0];
    expect(ready).toEqual([{ state, type: 'lyn-club-sso-ready', challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }, clubOrigin]);
    await test.receive();
    expect(test.fetcher).toHaveBeenCalledWith('/api/auth/club-sso/exchange', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(test.fetcher.mock.calls[0][1].body);
    const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier));
    expect(Buffer.from(hash).toString('base64url')).toBe(ready[0].challenge);
    expect(test.host.localStorage.setItem).toHaveBeenCalledWith('ceo_token', 'local-session');
    expect(test.host.location.replace).toHaveBeenCalledWith('/?view=meetings');
    expect(test.host.opener).toBeNull();
  });
  it('ignores foreign origins, wrong windows and wrong state', async () => {
    const test = setup();
    await test.receive({ origin: 'https://evil.example' });
    await test.receive({ source: {} });
    await test.receive({ data: { state: 'wrong', type: 'lyn-club-sso-code', code: 'c'.repeat(43) } });
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.host.localStorage.setItem).not.toHaveBeenCalled();
  });
  it('does not save a rejected exchange or silently reuse another dashboard user', async () => {
    const test = setup({ ok: false, json: async () => ({ error: 'Acceso caducado' }) });
    await test.receive();
    expect(test.onError).toHaveBeenCalledWith('Acceso caducado');
    expect(test.host.localStorage.setItem).not.toHaveBeenCalled();
    expect(test.host.location.replace).not.toHaveBeenCalled();
  });
  it('cannot exchange the same message twice', async () => {
    const test = setup();
    await Promise.all([test.receive(), test.receive()]);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops waiting after 90 seconds', () => {
    vi.useFakeTimers(); const test = setup();
    vi.advanceTimersByTime(90001);
    expect(test.onError).toHaveBeenCalledWith(expect.stringContaining('caducado'));
    expect(test.host.removeEventListener).toHaveBeenCalled();
  });
  it('fails closed without trusted configuration or opener', () => {
    const onError = vi.fn();
    const host = { opener: null, location: { search: '' }, removeEventListener: vi.fn() };
    stops.push(beginClubSso({ host, clubOrigin: '', onError, cryptoApi: webcrypto }));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Abre el gestor desde Club LYN'));
  });
});
