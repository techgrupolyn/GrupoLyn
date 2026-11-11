import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { ProtocolAgentResult } from './protocol-agent.ts';
import { parseWeeklyWindow } from './protocol-weekly.ts';

type User = { id: number; externalId: string; role: string };
type CorpusStatus = { versionId: string | null; updatedAt: string | null; lastSyncedAt: string | null; fileCount: number };
type WeeklySnapshot = { preguntas: Record<string, unknown>[]; metricas: Record<string, unknown>[]; documentos: Record<string, unknown>[] };
type Options = {
  enabled: boolean;
  serviceToken: string;
  resolveUser: (externalId: string) => Promise<User | null>;
  ask: (user: User, question: string, context: Array<{ author: 'user' | 'assistant'; text: string }>) => Promise<ProtocolAgentResult>;
  confirm: (user: User, id: string, resolved: boolean) => Promise<boolean>;
  status: () => Promise<CorpusStatus>;
  weeklySnapshot: (from: string, to: string) => Promise<WeeklySnapshot>;
  now?: () => number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const driveId = /^[a-zA-Z0-9_-]{10,}$/u;

function secureMatch(actual: string, expected: string): boolean {
  if (!expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function stale(lastSyncedAt: string | null, now: number): boolean {
  const synced = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  return !Number.isFinite(synced) || now - synced > 24 * 60 * 60 * 1000;
}

export function createClubProtocolRouter(options: Options) {
  const router = Router();
  const now = options.now || Date.now;
  router.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!options.enabled || options.serviceToken.length < 32) return void res.status(503).json({ error: 'Integración no disponible' });
    if (req.get('Origin')) return void res.status(403).json({ error: 'Solo acceso entre servidores' });
    const authorization = req.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ') || !secureMatch(authorization.slice(7), options.serviceToken)) return void res.status(401).json({ error: 'Integración no autorizada' });
    next();
  });

  router.get('/reporte-semanal', async (req, res) => {
    try {
      const { from, to } = parseWeeklyWindow(req.query.from, req.query.to, now());
      const snapshot = await options.weeklySnapshot(from, to);
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 2_000_000) return void res.status(413).json({ error: 'Resumen demasiado grande' });
      res.json(snapshot);
    } catch (error) {
      res.status(error instanceof Error && error.message === 'Periodo inválido' ? 400 : 503).json({ error: 'No se pudo preparar el resumen' });
    }
  });

  router.use(async (req, res, next) => {
    const externalId = req.get('X-Club-User-Id') || '';
    if (!uuid.test(externalId)) return void res.status(400).json({ error: 'Identidad de Club inválida' });
    try {
      const user = await options.resolveUser(externalId);
      if (!user) return void res.status(400).json({ error: 'Usuario interno no autorizado' });
      res.locals.clubProtocolUser = user;
      next();
    } catch {
      res.status(503).json({ error: 'No se pudo verificar la identidad de Club' });
    }
  });

  router.get('/estado', async (_req, res) => {
    try {
      const status = await options.status();
      res.json({ ...status, desactualizado: stale(status.lastSyncedAt, now()) });
    } catch { res.status(503).json({ error: 'No se pudo comprobar el corpus' }); }
  });

  router.post('/consultas', rateLimit({
    windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (_req, res) => (res.locals.clubProtocolUser as User).externalId,
  }), async (req, res) => {
    const user = res.locals.clubProtocolUser as User;
    const body = req.body as Record<string, unknown> | null;
    const question = body?.pregunta;
    const context = body?.contexto ?? [];
    if (body?.usuario_id !== user.externalId || body?.canal !== 'club_lyn' ||
        !uuid.test(String(body?.conversacion_id || '')) || typeof question !== 'string' ||
        !question.trim() || question.length > 2000 || !Array.isArray(context) || context.length > 6 ||
        context.some(turn => !turn || !['user', 'assistant'].includes(turn.author) || typeof turn.text !== 'string' || turn.text.length > 2000)) {
      return void res.status(400).json({ error: 'Consulta inválida' });
    }
    try {
      const [result, status] = await Promise.all([options.ask(user, question, context), options.status().catch(() => null)]);
      res.json({
        consulta_id: result.id,
        clasificacion: result.classification,
        respuesta: result.answer,
        fuentes: result.sources.map(source => ({
          documento: source.name,
          seccion: source.seccion,
          cita: source.cita,
          url: driveId.test(source.doc_id) ? source.mimeType === 'application/vnd.google-apps.spreadsheet'
            ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(source.doc_id)}/edit`
            : `https://drive.google.com/file/d/${encodeURIComponent(source.doc_id)}/view` : null,
        })),
        derivacion: { cargo: result.derivationRole, persona: result.derivationPerson },
        corpus: { version: result.corpusVersionId, fecha: status?.updatedAt || null, desactualizado: stale(status?.lastSyncedAt || null, now()) },
      });
    } catch (error) {
      const invalid = error instanceof Error && error.message === 'Consulta inválida';
      res.status(invalid ? 400 : 503).json({ error: invalid ? 'Consulta inválida' : 'El agente no está disponible' });
    }
  });

  router.post('/consultas/:id/confirmacion', async (req, res) => {
    if (!uuid.test(req.params.id) || typeof req.body?.resuelta !== 'boolean') return void res.status(400).json({ error: 'Confirmación inválida' });
    try {
      const saved = await options.confirm(res.locals.clubProtocolUser as User, req.params.id, req.body.resuelta);
      res.status(saved ? 200 : 404).json(saved ? { ok: true } : { error: 'Consulta no encontrada o ya confirmada' });
    } catch { res.status(503).json({ error: 'No se pudo guardar la confirmación' }); }
  });
  return router;
}
