import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GeminiExecutionResult } from './geminiService.ts';
import type { SummaryProgress } from './global-summary-batches.ts';

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
    ALTER TABLE resumenes_globales_chat ADD COLUMN IF NOT EXISTS evidence JSONB;
    ALTER TABLE resumenes_globales_chat ADD COLUMN IF NOT EXISTS coverage JSONB;
    CREATE TABLE IF NOT EXISTS summary_job_contexts (
      job_id UUID PRIMARY KEY REFERENCES summary_jobs(id) ON DELETE CASCADE, snapshot JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_job_batches (
      job_id UUID NOT NULL REFERENCES summary_jobs(id) ON DELETE CASCADE, cache_key TEXT NOT NULL,
      result JSONB NOT NULL, PRIMARY KEY(job_id,cache_key)
    );
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
  const progress = job.result?.progress as SummaryProgress | undefined;
  const description = progress?.stage === 'syncing' ? 'Recuperando de Evolution el historial pendiente antes de analizar. No se han descontado mensajes.' : progress
    ? `${progress.stage === 'consolidating' ? 'Preparando el informe' : progress.stage === 'verifying' ? 'Verificando evidencias' : 'Analizando por lotes'}: ${progress.completedBatches}/${progress.totalBatches} lotes de texto verificados. Los contadores se actualizan al guardar el informe completo.`
    : 'El informe global se está generando. El resultado aparecerá automáticamente cuando termine.';
  return { jobId: job.id, status: job.status, specialistId: job.specialist_id, en_progreso: ['queued','running'].includes(job.status),
    error: job.error, ...(job.result || {}),
    ...(job.status === 'queued' || job.status === 'running' ? { resumen: description } : {}),
  };
}

export function summaryJobStorage(pool: Pool, job: SummaryJob) {
  return {
    snapshot: async <Snapshot>(create: () => Promise<Snapshot>, reusable: (snapshot: Snapshot) => boolean = () => true): Promise<Snapshot> => {
      const existing = await pool.query('SELECT snapshot FROM summary_job_contexts WHERE job_id=$1', [job.id]);
      if (existing.rows[0] && reusable(existing.rows[0].snapshot)) return existing.rows[0].snapshot;
      if (existing.rows[0]) await pool.query('DELETE FROM summary_job_batches WHERE job_id=$1', [job.id]);
      const snapshot = await create();
      await pool.query('INSERT INTO summary_job_contexts(job_id,snapshot) VALUES($1,$2::jsonb) ON CONFLICT(job_id) DO UPDATE SET snapshot=EXCLUDED.snapshot', [job.id, JSON.stringify(snapshot)]);
      return snapshot;
    },
    read: async (key: string): Promise<GeminiExecutionResult | null> => {
      const result = await pool.query('SELECT result FROM summary_job_batches WHERE job_id=$1 AND cache_key=$2', [job.id, key]);
      return result.rows[0]?.result || null;
    },
    write: async (key: string, result: GeminiExecutionResult) => {
      await pool.query('INSERT INTO summary_job_batches(job_id,cache_key,result) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [job.id, key, JSON.stringify(result)]);
    },
    progress: async (progress: SummaryProgress) => {
      await pool.query("UPDATE summary_jobs SET result=jsonb_build_object('progress',$2::jsonb),updated_at=NOW() WHERE id=$1", [job.id, JSON.stringify(progress)]);
    },
  };
}

export function createSummaryQueue(pool: Pool, prepare: (job: SummaryJob) => Promise<SaveSummary>, notify: (job: SummaryJob) => void = () => {}) {
  let running: Promise<void> | null = null;
  const enqueue = async (accountId: string, specialistId: string): Promise<SummaryJob> => {
    try {
      const resumed = await pool.query<SummaryJob>(`UPDATE summary_jobs SET status='queued',attempts=0,error=NULL,updated_at=NOW()
        WHERE id=(SELECT id FROM summary_jobs WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)
        AND specialist_id=$2 AND status='failed'
        AND EXISTS (SELECT 1 FROM summary_job_contexts WHERE job_id=summary_jobs.id)
        AND NOT EXISTS (SELECT 1 FROM summary_jobs active WHERE active.account_id=$1 AND active.status IN ('queued','running')) RETURNING *`, [accountId, specialistId]);
      if (resumed.rows[0]) return resumed.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
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
          await client.query('DELETE FROM summary_job_batches WHERE job_id=$1', [job.id]);
          await client.query('DELETE FROM summary_job_contexts WHERE job_id=$1', [job.id]);
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
