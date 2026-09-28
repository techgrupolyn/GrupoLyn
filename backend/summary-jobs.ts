import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type SummaryJob = { id: string; account_id: string; specialist_id: string; status: string; attempts: number; error: string | null; result: Record<string, unknown> | null };
type SaveSummary = (client: PoolClient) => Promise<Record<string, unknown>>;
const activeLocks = new WeakMap<Pool, number>();
const clientPools = new WeakMap<PoolClient, Pool>();

export async function ensureSummaryJobs(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS summary_jobs (
      id UUID PRIMARY KEY, account_id VARCHAR(120) NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      specialist_id VARCHAR(120) NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS summary_jobs_active_account ON summary_jobs(account_id) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS summary_jobs_account_updated ON summary_jobs(account_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS summary_reviewed_messages (
      account_id VARCHAR(120) NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE, message_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account_id,message_id)
    );
    INSERT INTO summary_reviewed_messages(account_id,message_id)
      SELECT account_id,message_id FROM (
        SELECT account_id, UNNEST(mensaje_ids) AS message_id FROM resumenes_chat WHERE ai_fallback=FALSE
        UNION SELECT account_id, UNNEST(mensaje_ids) AS message_id FROM resumenes_globales_chat WHERE ai_fallback=FALSE
      ) history WHERE message_id IS NOT NULL AND EXISTS (SELECT 1 FROM whatsapp_accounts account WHERE account.id=history.account_id)
      ON CONFLICT DO NOTHING;
  `);
}

export async function acquireSummaryLock(pool: Pool, accountId: string): Promise<PoolClient | null> {
  const active = activeLocks.get(pool) || 0;
  if (active >= Math.max(1, Math.floor((pool.options.max || 10) / 2))) return null;
  activeLocks.set(pool, active + 1);
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) { activeLocks.set(pool, (activeLocks.get(pool) || 1) - 1); throw error; }
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`summary:${accountId}`]);
    if (result.rows[0].locked) { clientPools.set(client, pool); return client; }
    client.release();
    activeLocks.set(pool, (activeLocks.get(pool) || 1) - 1);
    return null;
  } catch (error) { client.release(true); activeLocks.set(pool, (activeLocks.get(pool) || 1) - 1); throw error; }
}

export async function releaseSummaryLock(client: PoolClient, accountId: string) {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`summary:${accountId}`]);
    client.release();
  } catch { client.release(true); }
  finally {
    const pool = clientPools.get(client);
    if (pool) { activeLocks.set(pool, Math.max(0, (activeLocks.get(pool) || 1) - 1)); clientPools.delete(client); }
  }
}

export async function markSummaryMessagesReviewed(client: PoolClient, accountId: string, variants: string[], messageIds: string[]) {
  const chats = await client.query('SELECT id,whatsapp_unread_count FROM chats WHERE account_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE', [accountId,variants]);
  const inserted = await client.query(`INSERT INTO summary_reviewed_messages(account_id,message_id)
    SELECT $1::varchar,message.id FROM mensajes message WHERE message.account_id=$1::varchar AND message.chat_id=ANY($2::text[]) AND message.id=ANY($3::text[])
    ON CONFLICT DO NOTHING RETURNING message_id`, [accountId,variants,messageIds]);
  const newIds = inserted.rows.map((row) => row.message_id);
  for (const chat of chats.rows) {
    const count = await client.query(`SELECT COUNT(*)::integer AS total FROM (
      SELECT id FROM mensajes WHERE account_id=$1 AND chat_id=$2 AND enviado_por_mi=FALSE ORDER BY timestamp DESC,id DESC LIMIT $3
    ) unread_window WHERE id=ANY($4::text[])`, [accountId,chat.id,Math.max(0,Number(chat.whatsapp_unread_count)),newIds]);
    await client.query(`UPDATE chats SET
      reviewed_unread_baseline=LEAST(GREATEST(0,whatsapp_unread_count),GREATEST(0,reviewed_unread_baseline)+$3::integer),
      unread_count=GREATEST(0,whatsapp_unread_count-LEAST(GREATEST(0,whatsapp_unread_count),GREATEST(0,reviewed_unread_baseline)+$3::integer))
      WHERE account_id=$1 AND id=$2`, [accountId,chat.id,count.rows[0].total]);
  }
  const remaining = await client.query('SELECT unread_count FROM chats WHERE account_id=$1 AND id=ANY($2::text[])', [accountId,variants]);
  return Math.max(0,...remaining.rows.map((row) => Number(row.unread_count)));
}

export function publicSummaryJob(job: SummaryJob) {
  return { jobId: job.id, status: job.status, specialistId: job.specialist_id, en_progreso: ['queued','running'].includes(job.status),
    error: job.error, ...(job.result || {}),
    ...(job.status === 'queued' || job.status === 'running' ? { resumen: 'El informe global se está generando. El resultado aparecerá automáticamente cuando termine.' } : {}),
  };
}

export function createSummaryQueue(pool: Pool, prepare: (job: SummaryJob) => Promise<SaveSummary>, notify: (job: SummaryJob) => void = () => {}) {
  let running: Promise<void> | null = null;
  const enqueue = async (accountId: string, specialistId: string): Promise<SummaryJob> => {
    const result = await pool.query(`INSERT INTO summary_jobs(id,account_id,specialist_id,status) VALUES($1,$2,$3,'queued')
      ON CONFLICT(account_id) WHERE status IN ('queued','running') DO UPDATE SET account_id=EXCLUDED.account_id RETURNING *`, [randomUUID(),accountId,specialistId]);
    return result.rows[0];
  };
  const run = () => {
    if (running) return running;
    running = (async () => {
      const candidates = await pool.query<SummaryJob>("SELECT * FROM summary_jobs WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 20");
      for (const candidate of candidates.rows) {
        const client = await acquireSummaryLock(pool,candidate.account_id);
        if (!client) continue;
        let claimed = false;
        try {
          const claim = await client.query<SummaryJob>(`UPDATE summary_jobs SET status='running',attempts=attempts+1,updated_at=NOW(),error=NULL
            WHERE id=$1 AND status IN ('queued','running') RETURNING *`, [candidate.id]);
          const job = claim.rows[0];
          if (!job) continue;
          claimed = true;
          if (job.attempts > 3) throw new SummaryJobError('El proceso se interrumpió varias veces. Inicia de nuevo el informe.');
          const save = await prepare(job);
          await client.query('BEGIN');
          const result = await save(client);
          const completed = await client.query<SummaryJob>("UPDATE summary_jobs SET status='completed',result=$2,error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *", [job.id,JSON.stringify(result)]);
          await client.query('COMMIT');
          try { notify(completed.rows[0]); } catch (error) { console.error('[summary-queue] Notification failed:', error); }
        } catch (error) {
          console.error('[summary-queue] Job failed:', candidate.id, error instanceof Error ? error.message : 'Unknown failure');
          await client.query('ROLLBACK').catch(() => undefined);
          if (claimed) {
            const message = error instanceof SummaryJobError ? error.message : 'No se pudo generar el informe. Reintenta; tus mensajes continúan pendientes.';
            const failed = await client.query<SummaryJob>("UPDATE summary_jobs SET status='failed',error=$2,updated_at=NOW() WHERE id=$1 AND status='running' RETURNING *", [candidate.id,message]);
            if (failed.rows[0]) {
              try { notify(failed.rows[0]); } catch (error) { console.error('[summary-queue] Notification failed:', error); }
            }
          }
        } finally { await releaseSummaryLock(client,candidate.account_id); }
      }
    })().finally(() => { running=null; });
    return running;
  };
  return { enqueue, run };
}

export class SummaryJobError extends Error {}
