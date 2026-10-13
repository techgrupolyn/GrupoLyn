import { requestWithDeadline } from './request-deadline.ts';

export type SupabaseAuthConfig = {
  url: string;
  key: string;
  enabled: boolean;
};

export type SupabaseAuthenticatedUser = {
  id: string;
  email: string;
  name: string | null;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>;

export class SupabaseAuthServiceError extends Error {}

export async function authenticateWithSupabaseAccessToken(
  token: string,
  config: SupabaseAuthConfig = supabaseAuthConfigFromEnv(),
  fetchImplementation: FetchImplementation = fetch,
): Promise<SupabaseAuthenticatedUser | null> {
  if (!isSupabaseAuthConfigured(config) || !token || token.length > 16384) return null;
  try {
    return await requestWithDeadline(async (signal) => {
      const response = await fetchImplementation(new URL('/auth/v1/user', `${config.url}/`), {
        method: 'GET',
        headers: { apikey: config.key, Authorization: `Bearer ${token}` },
        signal,
      });
      if ([400, 401, 403].includes(response.status)) return null;
      if (!response.ok) throw new SupabaseAuthServiceError('Supabase no está disponible');
      const user = await response.json();
      if (!(user as { email_confirmed_at?: string } | null)?.email_confirmed_at) return null;
      return readUser({ user });
    }, 10000);
  } catch {
    throw new SupabaseAuthServiceError('No se pudo verificar la sesión de Club LYN');
  }
}

export function supabaseAuthConfigFromEnv(env = process.env): SupabaseAuthConfig {
  return {
    url: String(env.SUPABASE_SOURCE_URL || '').trim().replace(/\/+$/, ''),
    key: String(env.SUPABASE_SOURCE_SECRET_KEY || '').trim(),
    enabled: String(env.SUPABASE_AUTH_ENABLED || '').trim().toLowerCase() === 'true',
  };
}

export function isSupabaseAuthConfigured(config: SupabaseAuthConfig): boolean {
  return Boolean(config.enabled && config.url && config.key);
}

function readUser(payload: unknown): SupabaseAuthenticatedUser | null {
  const user = (payload as { user?: Record<string, unknown> } | null)?.user;
  const id = String(user?.id || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();
  if (!id || !email) return null;
  const metadata = user?.user_metadata as Record<string, unknown> | undefined;
  const name = String(metadata?.full_name || metadata?.name || '').trim() || null;
  return { id, email, name };
}

export async function authenticateWithSupabasePassword(
  email: string,
  password: string,
  config: SupabaseAuthConfig = supabaseAuthConfigFromEnv(),
  fetchImplementation: FetchImplementation = fetch,
): Promise<SupabaseAuthenticatedUser | null> {
  if (!isSupabaseAuthConfigured(config)) return null;
  const target = new URL('/auth/v1/token', `${config.url}/`);
  target.searchParams.set('grant_type', 'password');
  let response: FetchResponse;
  try {
    response = await fetchImplementation(target, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SupabaseAuthServiceError('No se pudo contactar el servicio de autenticación');
  }
  if ([400, 401, 422].includes(response.status)) return null;
  if (!response.ok) throw new SupabaseAuthServiceError(`El servicio de autenticación respondió HTTP ${response.status}`);
  return readUser(await response.json());
}
