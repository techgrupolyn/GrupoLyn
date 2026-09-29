import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { MessageItem } from './types/index.ts';

const activeDeliveries = new WeakMap<Pool, number>();

export async function ensureWhatsAppReliability(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_inbox (
      id BIGSERIAL PRIMARY KEY,
      account_id VARCHAR(120) NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL, payload JSONB NOT NULL, historical BOOLEAN NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT,
      UNIQUE(account_id,payload_hash,historical)
    );
    CREATE INDEX IF NOT EXISTS whatsapp_message_inbox_due ON whatsapp_message_inbox(next_attempt_at,id);
    CREATE TABLE IF NOT EXISTS whatsapp_sync_health (
      account_id VARCHAR(120) PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), state TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}

export function createWhatsAppInbox<Result>(pool: Pool, persist: (accountId: string, message: MessageItem, historical: boolean) => Promise<Result>) {
  let running: Promise<void> | null = null;
  const accept = async (accountId: string, messages: MessageItem[], historical: boolean): Promise<string[]> => {
    if (!messages.length) return [];
    const entries = messages.map((payload) => ({ payload, hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
    const unique = [...new Map(entries.map((entry) => [entry.hash, entry])).values()];
    const result = await pool.query(`INSERT INTO whatsapp_message_inbox(account_id,payload_hash,payload,historical)
      SELECT $1,entry.hash,entry.payload,$3 FROM jsonb_to_recordset($2::jsonb) AS entry(hash text,payload jsonb)
      ON CONFLICT(account_id,payload_hash,historical) DO UPDATE SET payload_hash=EXCLUDED.payload_hash
      RETURNING id,payload_hash`, [accountId, JSON.stringify(unique), historical]);
    const receipts = new Map(result.rows.map((row) => [row.payload_hash as string, String(row.id)]));
    return entries.map((entry) => receipts.get(entry.hash)!);
  };
  const deliverLocked = async (id: string): Promise<Result | null> => {
    const client = await pool.connect();
    let lock: string | null = null;
    try {
      const initial = await client.query('SELECT account_id FROM whatsapp_message_inbox WHERE id=$1', [id]);
      if (!initial.rows.length) return null;
      const lockKey = `whatsapp-inbox:${initial.rows[0].account_id}`;
      const acquired = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey]);
      if (!acquired.rows[0].locked) return null;
      lock = lockKey;
      const pending = await client.query(`SELECT inbox.* FROM whatsapp_message_inbox inbox
        JOIN whatsapp_accounts account ON account.id=inbox.account_id
        WHERE inbox.id=$1 AND account.activo=TRUE AND inbox.next_attempt_at<=NOW()`, [id]);
      const item = pending.rows[0];
      if (!item) return null;
      try {
        const result = await persist(item.account_id, item.payload, item.historical);
        await client.query('DELETE FROM whatsapp_message_inbox WHERE id=$1', [id]);
        return result;
      } catch {
        await client.query(`UPDATE whatsapp_message_inbox SET attempts=attempts+1,
          next_attempt_at=NOW()+LEAST(300,5*POWER(2,LEAST(attempts,6)))*INTERVAL '1 second',
          last_error='No se pudo completar la persistencia; pendiente de reintento' WHERE id=$1`, [id]);
        console.warn('[whatsapp-inbox] Persistencia pendiente', { accountId: item.account_id, receiptId: id, attempts: item.attempts + 1 });
        return null;
      }
    } finally {
      if (lock) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); }
        catch { client.release(true); lock = null; }
        if (lock) client.release();
      } else client.release();
    }
  };
  const deliver = async (id: string): Promise<Result | null> => {
    const active = activeDeliveries.get(pool) || 0;
    if (active >= Math.max(1, Math.floor((pool.options.max || 10) / 2))) return null;
    activeDeliveries.set(pool, active + 1);
    try { return await deliverLocked(id); }
    finally { activeDeliveries.set(pool, (activeDeliveries.get(pool) || 1) - 1); }
  };
  const run = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const due = await pool.query(`SELECT inbox.id FROM whatsapp_message_inbox inbox
        JOIN whatsapp_accounts account ON account.id=inbox.account_id
        WHERE account.activo=TRUE AND inbox.next_attempt_at<=NOW()
        ORDER BY inbox.next_attempt_at,inbox.id LIMIT 25`);
      for (const item of due.rows) await deliver(String(item.id));
    })().finally(() => { running = null; });
    return running;
  };
  return { accept, deliver, run };
}

export async function pendingWhatsAppCoverage(pool: Pool, accountId: string) {
  const result = await pool.query<{ group: string; pending: number; unavailable: number; empty: number }>(`
    SELECT c.id AS "group", c.unread_count AS pending,
      GREATEST(0,c.unread_count-coverage.available)::integer AS unavailable, coverage.empty
    FROM chats c CROSS JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE reviewed.message_id IS NULL)::integer AS available,
        COUNT(*) FILTER (WHERE reviewed.message_id IS NULL AND LOWER(COALESCE(message.tipo,'text'))='text'
          AND BTRIM(COALESCE(message.texto,''))='')::integer AS empty
      FROM (
        SELECT id,tipo,texto FROM mensajes WHERE account_id=c.account_id AND chat_id=c.id
          AND enviado_por_mi=FALSE ORDER BY timestamp DESC,id DESC
        LIMIT GREATEST(c.whatsapp_unread_count,c.unread_count)
      ) message LEFT JOIN summary_reviewed_messages reviewed
        ON reviewed.account_id=c.account_id AND reviewed.message_id=message.id
    ) coverage WHERE c.account_id=$1 AND c.unread_count>0 AND c.id LIKE '%@g.us'
    ORDER BY c.id`, [accountId]);
  return result.rows.filter((group) => group.unavailable || group.empty);
}

export async function recordWhatsAppHealth(pool: Pool, accountId: string, state: string, details: Record<string, unknown>) {
  const previous = await pool.query('SELECT state FROM whatsapp_sync_health WHERE account_id=$1', [accountId]);
  await pool.query(`INSERT INTO whatsapp_sync_health(account_id,state,details) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(account_id) DO UPDATE SET state=EXCLUDED.state,details=EXCLUDED.details,checked_at=NOW()`, [accountId, state, JSON.stringify(details)]);
  if (previous.rows[0]?.state !== state) console.warn('[whatsapp-sync-health]', { accountId, state });
}
