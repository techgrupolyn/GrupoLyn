// Llamadas de Netelip (y WhatsApp vía Asterisk): ticket 869fcamvx. Ver docs/NETELIP_LLAMADAS.md.
//
//   ensureNetelipCalls(pool)          esquema aditivo (en ensureDatabaseSchema)
//   registerNetelipCalls(app, deps)   receptor /webhook/netelip/... y API /api/netelip/...
//   startNetelipWorkers(pool)         procesado en segundo plano (en bootstrap)
import type { Pool } from 'pg';
import { relinkCalls } from './contacts.ts';
import { applyRetention, notifyTech, processInbox, processNextTranscription, reconcile, recoverFromVdrive } from './processing.ts';
import { buildEngine } from './transcription.ts';
import { VdriveClient, vdriveConfigFromEnv } from './vdrive.ts';

export { ensureNetelipCalls } from './schema.ts';
export { registerNetelipCalls } from './routes.ts';
export { relinkCalls } from './contacts.ts';

const INBOX_INTERVAL_MS = 5_000;
const TRANSCRIPTION_INTERVAL_MS = 10_000;
const RELINK_INTERVAL_MS = 5 * 60_000;
const RECONCILE_INTERVAL_MS = 60 * 60_000;
const RETENTION_INTERVAL_MS = 24 * 3600_000;
const RECOVERY_INTERVAL_MS = 5 * 60_000;

function days(name: string, env: NodeJS.ProcessEnv): number | null {
  const raw = String(env[name] || '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser un entero >= 1`);
  return value;
}

/** Ejecuta `task` sin solapar ejecuciones: si la anterior sigue en curso, se salta el ciclo. */
function singleFlight(name: string, task: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    task().catch((error) => console.error(`[netelip] Error en ${name}:`, (error as Error).message)).finally(() => { running = false; });
  };
}

/** Un aviso de trabajo nuevo antes de arrancar los procesos no se pierde: lo recoge el primer ciclo. */
export function createNetelipWorkers(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  const engine = buildEngine(env);
  const transcriptDays = days('NETELIP_TRANSCRIPT_RETENTION_DAYS', env);
  const audioDays = days('NETELIP_AUDIO_RETENTION_DAYS', env);

  // Whisper ocupa toda la CPU: una transcripción cada vez, en bucle mientras haya pendientes.
  const transcribe = singleFlight('transcripción', async () => {
    if (!engine) return;
    while (await processNextTranscription(pool, engine)) { /* siguiente */ }
  });
  const inbox = singleFlight('bandeja', async () => {
    while ((await processInbox(pool)) > 0) { /* siguiente lote */ }
    transcribe();
  });
  const relink = singleFlight('re-vinculación', async () => {
    const changed = await relinkCalls(pool);
    if (changed) console.log(JSON.stringify({ msg: 'netelip_relinked', calls: changed }));
  });
  const reconcileTask = singleFlight('conciliación', async () => {
    const summary = await reconcile(pool, new Date(), Boolean(engine));
    if (Object.values(summary).some(Boolean)) console.log(JSON.stringify({ msg: 'netelip_reconcile_done', ...summary }));
  });
  const vdriveConfig = vdriveConfigFromEnv(env);
  const vdrive = vdriveConfig ? new VdriveClient(vdriveConfig) : null;
  const recover = singleFlight('recuperación desde vDrive', async () => {
    if (!vdrive) return;
    const summary = await recoverFromVdrive(pool, vdrive, new Date(), env.NETELIP_RECORD_AUDIO === 'stereo');
    if (summary.recovered) transcribe();
    if (summary.recovered || summary.not_found) console.log(JSON.stringify({ msg: 'netelip_vdrive_recovery', ...summary }));
  });
  const retention = singleFlight('retención', async () => {
    const summary = await applyRetention(pool, new Date(), transcriptDays, audioDays);
    console.log(JSON.stringify({ msg: 'netelip_retention_done', transcript_days: transcriptDays, audio_days: audioDays, ...summary }));
  });

  return {
    kick: inbox,
    relink,
    recover,
    start() {
      if (!engine) console.warn('[netelip] Sin motor de transcripción (NETELIP_TRANSCRIPTION_ENGINE): las transcripciones quedan pendientes');
      if (!transcriptDays && !audioDays) console.warn('[netelip] Retención sin configurar (P5): no se borra ninguna transcripción ni audio');
      if (!vdrive) console.warn('[netelip] Sin acceso a vDrive (NETELIP_VDRIVE_USER / NETELIP_VDRIVE_APP_PASSWORD): no se recuperan llamadas sin aviso de grabación ni se podrán transcribir las pendientes cuando caduque su URL');
      // Las transcripciones pendientes dependen de vDrive para descargar el audio: si las credenciales fallan, avisar al arrancar.
      else vdrive.list('/APIVoice/Record').catch((error) => notifyTech('vDrive de Netelip inaccesible', { error: (error as Error).message.slice(0, 300) }));
      for (const [task, ms] of [[inbox, INBOX_INTERVAL_MS], [transcribe, TRANSCRIPTION_INTERVAL_MS], [relink, RELINK_INTERVAL_MS],
        [reconcileTask, RECONCILE_INTERVAL_MS], [retention, RETENTION_INTERVAL_MS], [recover, RECOVERY_INTERVAL_MS]] as const) {
        task();
        setInterval(task, ms).unref();
      }
    },
  };
}
