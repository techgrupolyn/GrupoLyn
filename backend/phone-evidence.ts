import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { normalizePhone, PhoneNormalizationError } from './phone-normalization.ts';

export type PhoneEvidenceConfig = {
  enabled: boolean;
  token: string;
  accountIds: string[];
};
export type PhoneEvidence = { project: string; last_message_at: string };
type EvidenceRow = { project: string; last_message_at: Date | string };
type EvidenceDatabase = Pick<Pool, 'connect'>;

export const phoneDirectoryFreshnessQuery = `SELECT EXISTS (
  SELECT 1 FROM directory_sync_runs
  WHERE source='supabase' AND status='success' AND finished_at>=NOW()-INTERVAL '2 hours'
) AS fresh`;

export async function assertPhoneDirectoryFresh(client: { query: (sql: string) => Promise<{ rows: { fresh: boolean }[] }> }): Promise<void> {
  const { rows } = await client.query(phoneDirectoryFreshnessQuery);
  if (!rows[0]?.fresh) throw new Error('Employee directory unavailable');
}

export function phoneEvidenceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PhoneEvidenceConfig {
  return {
    enabled: env.CLUB_PHONE_EVIDENCE_ENABLED === 'true',
    token: env.CLUB_PHONE_EVIDENCE_TOKEN?.trim() || '',
    accountIds: [...new Set((env.CLUB_PHONE_EVIDENCE_ACCOUNT_IDS || '').split(',').map(value => value.trim()).filter(Boolean))],
  };
}

export const phoneEvidenceSenderPrefilter = `
    AND CASE WHEN message.remitente_jid ~ '^[1-9][0-9]{7,14}(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
      THEN regexp_replace(split_part(message.remitente_jid, '@', 1), ':[0-9]+$', '')=$1
      ELSE TRUE END`;

export const phoneEvidenceDirectoryGuard = `
    AND EXISTS (
      SELECT 1 FROM directory_sync_runs sync
      WHERE sync.source='supabase' AND sync.status='success'
        AND sync.finished_at>=NOW()-INTERVAL '2 hours'
    )
    AND NOT EXISTS (
      SELECT 1 FROM empleados employee
      WHERE employee.numero IS NOT NULL AND employee.synced_at>=NOW()-INTERVAL '2 hours'
        AND length(regexp_replace(employee.numero,'[^0-9]','','g')) BETWEEN 8 AND 15
        AND right($1, length(regexp_replace(employee.numero,'[^0-9]','','g')))
          =regexp_replace(employee.numero,'[^0-9]','','g')
    )`;

export const phoneEvidenceReferenceQuery = `
  SELECT regexp_replace(chat.nombre, '^Proyecto[[:space:]]+', '') AS project,
         message.timestamp AS last_message_at
  FROM mensajes message
  JOIN chats chat ON chat.id=message.chat_id AND chat.account_id=message.account_id
  JOIN whatsapp_accounts account ON account.id=message.account_id AND account.activo=TRUE
  CROSS JOIN LATERAL (
    SELECT ARRAY(
      SELECT DISTINCT regexp_replace(split_part(candidate, '@', 1), ':[0-9]+$', '')
      FROM unnest(ARRAY[
        message.remitente_jid,
        message.raw->>'participantJid',
        message.raw#>>'{key,participant}',
        message.raw#>>'{key,participantJid}',
        message.raw#>>'{key,participantAlt}'
      ]) AS candidates(candidate)
      WHERE candidate ~ '^[1-9][0-9]{7,14}(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
    ) AS phones
  ) sender
  WHERE message.account_id=ANY($2::varchar[])
    AND chat.account_id=ANY($2::varchar[])
    AND message.enviado_por_mi=FALSE
    AND message.source='evolution'
    AND COALESCE(message.raw#>>'{key,fromMe}', 'false')='false'
    AND chat.id LIKE '%@g.us'
    AND chat.nombre ~ '^Proyecto[[:space:]]+[^[:space:]]'
    ${phoneEvidenceDirectoryGuard}
    ${phoneEvidenceSenderPrefilter}
    AND cardinality(sender.phones)=1 AND sender.phones[1]=$1
    AND message.timestamp>to_timestamp(0) AND message.timestamp<=NOW()
    AND (
      (LOWER(COALESCE(message.tipo,'text'))='text' AND BTRIM(COALESCE(message.texto,''))<>'')
      OR LOWER(message.tipo) IN ('image','video','audio','document','sticker','contact')
    )
  ORDER BY message.timestamp DESC, chat.id, message.id
  LIMIT 1`;

export const phoneEvidenceQuery = `
  SELECT regexp_replace(chat.nombre, '^Proyecto[[:space:]]+', '') AS project,
         message.timestamp AS last_message_at
  FROM mensajes message
  JOIN chats chat ON chat.id=message.chat_id AND chat.account_id=message.account_id
  JOIN whatsapp_accounts account ON account.id=message.account_id AND account.activo=TRUE
  WHERE message.account_id=ANY($2::varchar[])
    AND chat.account_id=ANY($2::varchar[])
    AND message.enviado_por_mi=FALSE
    AND message.source='evolution'
    AND chat.id LIKE '%@g.us'
    AND chat.nombre ~ '^Proyecto[[:space:]]+[^[:space:]]'
    ${phoneEvidenceDirectoryGuard}
    AND public.lyn_phone_evidence_sender_v1(message.remitente_jid, message.raw)=$1
    AND message.timestamp>to_timestamp(0) AND message.timestamp<=NOW()
    AND (
      (LOWER(COALESCE(message.tipo,'text'))='text' AND BTRIM(COALESCE(message.texto,''))<>'')
      OR LOWER(message.tipo) IN ('image','video','audio','document','sticker','contact')
    )
  ORDER BY message.timestamp DESC, chat.id, message.id
  LIMIT 1`;

export function createPhoneEvidenceLookup(pool: EvidenceDatabase) {
  return async (phone: string, accountIds: string[]): Promise<PhoneEvidence | null> => {
    if (!/^\+[1-9][0-9]{7,14}$/.test(phone) || !accountIds.length) throw new Error('Invalid evidence scope');
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'");
      await assertPhoneDirectoryFresh(client);
      const { rows } = await client.query<EvidenceRow>(phoneEvidenceQuery, [phone.slice(1), accountIds]);
      await client.query('COMMIT');
      const row = rows[0];
      return row ? { project: row.project, last_message_at: new Date(row.last_message_at).toISOString() } : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

export function createPhoneEvidenceRouter(config: PhoneEvidenceConfig, lookup: (phone: string, accountIds: string[]) => Promise<PhoneEvidence | null>,
  inferPrefix: (phone: string, accountIds: string[]) => Promise<string | null> = async () => null) {
  const router = express.Router();
  const accountIds = [...config.accountIds];
  const tokenHash = createHash('sha256').update(config.token).digest();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) { res.status(404).json({ code: 'not_found' }); return; }
    if (config.token.length < 32 || !accountIds.length || accountIds.some(id => !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) {
      res.status(503).json({ code: 'integration_unavailable' }); return;
    }
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { code: 'rate_limited' } }));
  router.use((req, res, next) => {
    if (req.headers.origin !== undefined) { res.status(403).json({ code: 'server_to_server_only' }); return; }
    const authorization = req.header('authorization') || '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!supplied || !timingSafeEqual(tokenHash, createHash('sha256').update(supplied).digest())) {
      res.status(401).json({ code: 'unauthorized' }); return;
    }
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 60, keyGenerator: () => 'club-phone-evidence', standardHeaders: true, legacyHeaders: false, message: { code: 'rate_limited' } }));
  router.use(express.json({ limit: '2kb', strict: true }));
  router.post('/', async (req, res) => {
    if (!req.is('application/json') || !req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !['phone', 'country'].includes(key))) {
      res.status(400).json({ code: 'invalid_request' }); return;
    }
    let normalized: ReturnType<typeof normalizePhone>;
    let inferred = false;
    try {
      normalized = normalizePhone(req.body.phone, req.body.country);
    } catch (error) {
      if (!(error instanceof PhoneNormalizationError) || error.code !== 'country_required') {
        res.status(422).json({ code: error instanceof PhoneNormalizationError ? error.code : 'invalid_phone' }); return;
      }
      try {
        const candidate = await inferPrefix(req.body.phone, accountIds);
        if (candidate) {
          normalized = normalizePhone(candidate);
          inferred = true;
        } else {
          const digits = req.body.phone.replace(/[\s().-]/g, '');
          const fallback = digits.startsWith('34') && digits.length === 11 ? `+${digits}` : `+34${digits}`;
          if (!/^\+[1-9][0-9]{7,14}$/.test(fallback)) throw new PhoneNormalizationError('invalid_phone');
          try {
            normalized = normalizePhone(fallback);
          } catch (normalizationError) {
            if (!(normalizationError instanceof PhoneNormalizationError) || normalizationError.code !== 'invalid_phone') throw normalizationError;
            normalized = { phone: fallback, country: 'ES', calling_code: '+34' };
          }
        }
      } catch (error) {
        if (error instanceof PhoneNormalizationError) { res.status(422).json({ code: 'country_required' }); return; }
        res.setHeader('Retry-After', '60');
        res.status(503).json({ code: 'evidence_unavailable' }); return;
      }
    }
    try {
      const evidence = await lookup(normalized.phone, accountIds);
      if (inferred && !evidence) { res.setHeader('Retry-After', '60'); res.status(503).json({ code: 'evidence_unavailable' }); return; }
      res.json({
        ...normalized,
        verified: Boolean(evidence),
        method: evidence ? 'WhatsApp' : null,
        reason: evidence ? 'message_found' : 'no_evidence',
        project: evidence?.project || null,
        last_message_at: evidence?.last_message_at || null,
      });
    } catch {
      res.setHeader('Retry-After', '60');
      res.status(503).json({ code: 'evidence_unavailable' });
    }
  });
  router.use((_req, res) => { res.status(404).json({ code: 'not_found' }); });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ code: 'invalid_request' });
  };
  router.use(handleError);
  return router;
}
