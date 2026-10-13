import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { SupabaseAuthenticatedUser } from './supabase-auth.ts';

type DashboardUser = { id: number; usuario: string; nombre: string | null; rol: string };
type SsoOptions = {
  clubOrigin: string;
  dashboardOrigin: string;
  authenticate: (token: string) => Promise<SupabaseAuthenticatedUser | null>;
  resolveUser: (user: SupabaseAuthenticatedUser) => Promise<DashboardUser | null>;
  createToken: (user: DashboardUser) => string;
  now?: () => number;
};

export function ssoOrigin(value: string | undefined): string {
  try {
    const url = new URL(value || '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : '';
  } catch { return ''; }
}

export function createClubSsoRouter(options: SsoOptions) {
  const router = Router();
  const clubOrigin = ssoOrigin(options.clubOrigin);
  const dashboardOrigin = ssoOrigin(options.dashboardOrigin);
  const now = options.now || Date.now;
  const grants = new Map<string, { user: SupabaseAuthenticatedUser; challenge: string; expires: number }>();
  const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
  const prune = () => {
    for (const [key, grant] of grants) if (grant.expires <= now()) grants.delete(key);
  };
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!clubOrigin || !dashboardOrigin) { res.status(503).json({ error: 'Acceso desde Club LYN no configurado' }); return; }
    next();
  });
  router.use(cors({ origin: [clubOrigin, dashboardOrigin].filter(Boolean), methods: ['POST'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 300 }));
  router.use(rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera un minuto.' } }));
  router.post('/handoff', async (req, res) => {
    if (req.get('Origin') !== clubOrigin) { res.status(403).json({ error: 'Origen no permitido' }); return; }
    const challenge = req.body?.challenge;
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { res.status(400).json({ error: 'Solicitud de acceso inválida' }); return; }
    const authorization = req.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) { res.status(401).json({ error: 'Inicia sesión en Club LYN' }); return; }
    try {
      const remoteUser = await options.authenticate(authorization.slice(7));
      if (!remoteUser) { res.status(401).json({ error: 'La sesión de Club LYN ha caducado' }); return; }
      const user = await options.resolveUser(remoteUser);
      if (!user) { res.status(403).json({ error: 'Tu cuenta no tiene acceso al gestor de reuniones' }); return; }
      prune();
      if (grants.size >= 1000) { res.status(503).json({ error: 'Acceso ocupado; inténtalo de nuevo' }); return; }
      const code = randomBytes(32).toString('base64url');
      grants.set(digest(code), { user: remoteUser, challenge, expires: now() + 60000 });
      res.json({ code, expiresIn: 60 });
    } catch {
      res.status(502).json({ error: 'No se pudo verificar el acceso. Inténtalo de nuevo.' });
    }
  });
  router.post('/exchange', async (req, res) => {
    if (req.get('Origin') !== dashboardOrigin) { res.status(403).json({ error: 'Origen no permitido' }); return; }
    const { code, verifier } = req.body || {};
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code) || typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
      res.status(400).json({ error: 'Solicitud de acceso inválida' }); return;
    }
    prune();
    const key = digest(code);
    const grant = grants.get(key);
    if (!grant || grant.challenge !== digest(verifier)) { res.status(401).json({ error: 'Acceso caducado o inválido; vuelve a abrirlo desde Club LYN' }); return; }
    grants.delete(key);
    try {
      const user = await options.resolveUser(grant.user);
      if (!user) { res.status(403).json({ error: 'Tu cuenta no tiene acceso al gestor de reuniones' }); return; }
      res.json({ usuario: user, token: options.createToken(user) });
    } catch {
      res.status(502).json({ error: 'No se pudo iniciar sesión; vuelve a abrir el gestor desde Club LYN' });
    }
  });
  return router;
}
