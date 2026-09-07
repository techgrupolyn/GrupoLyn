import { describe, expect, it, vi } from 'vitest';
import { authenticateWithSupabasePassword, isSupabaseAuthConfigured, supabaseAuthConfigFromEnv, SupabaseAuthServiceError } from '../supabase-auth.ts';

describe('Supabase dashboard authentication', () => {
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