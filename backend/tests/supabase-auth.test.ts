import { describe, expect, it, vi } from 'vitest';
import { authenticateWithSupabasePassword, authenticateWithSupabaseAccessToken, isSupabaseAuthConfigured, supabaseAuthConfigFromEnv, SupabaseAuthServiceError } from '../supabase-auth.ts';

describe('Supabase dashboard authentication', () => {
  it('verifies the access token against the configured issuer without trusting token metadata roles', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'uid', email: 'staff@example.test', email_confirmed_at: '2026-01-01', user_metadata: { name: 'Staff', role: 'admin' } }) }));
    const result = await authenticateWithSupabaseAccessToken('access-token', { enabled: true, url: 'https://trusted.example', key: 'key' }, fetcher);
    expect(result).toEqual({ id: 'uid', email: 'staff@example.test', name: 'Staff' });
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://trusted.example/auth/v1/user' }), expect.objectContaining({ headers: { apikey: 'key', Authorization: 'Bearer access-token' } }));
  });
  it('rejects an unconfirmed email and remote rejected tokens', async () => {
    const config = { enabled: true, url: 'https://trusted.example', key: 'key' };
    expect(await authenticateWithSupabaseAccessToken('token', config, async () => ({ ok: true, status: 200, json: async () => ({ id: 'uid', email: 'staff@example.test' }) }))).toBeNull();
    expect(await authenticateWithSupabaseAccessToken('token', config, async () => ({ ok: false, status: 401, json: async () => ({}) }))).toBeNull();
  });
  it('stays disabled until explicitly enabled', () => {
    const config = supabaseAuthConfigFromEnv({ SUPABASE_SOURCE_URL: 'https://example.supabase.co', SUPABASE_SOURCE_SECRET_KEY: 'key' });
    expect(isSupabaseAuthConfigured(config)).toBe(false);
  });

  it('authenticates server-side without retaining the returned tokens', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'discarded', refresh_token: 'discarded', user: { id: 'user-1', email: 'person@grupolyn.com', user_metadata: { full_name: 'Persona LYN' } } }),
    }));
    const user = await authenticateWithSupabasePassword('person@grupolyn.com', 'secret', { url: 'https://source.example', key: 'server-key', enabled: true }, fetcher);
    expect(user).toEqual({ id: 'user-1', email: 'person@grupolyn.com', name: 'Persona LYN' });
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/auth/v1/token', search: '?grant_type=password' }), expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ email: 'person@grupolyn.com', password: 'secret' });
  });

  it('does not expose whether an invalid remote credential exists', async () => {
    const user = await authenticateWithSupabasePassword('person@grupolyn.com', 'wrong', { url: 'https://source.example', key: 'server-key', enabled: true }, async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(user).toBeNull();
  });

  it('reports unavailable remote authentication separately', async () => {
    await expect(authenticateWithSupabasePassword('person@grupolyn.com', 'secret', { url: 'https://source.example', key: 'server-key', enabled: true }, async () => ({ ok: false, status: 503, json: async () => ({}) }))).rejects.toBeInstanceOf(SupabaseAuthServiceError);
  });
});
