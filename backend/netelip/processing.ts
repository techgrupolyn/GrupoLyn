// Procesado en segundo plano: bandeja del receptor → llamada → transcripción, más conciliación,
// retención y supresión. Todo sobre PostgreSQL (sin colas externas), con reintentos y SKIP LOCKED
// para que dos ejecuciones no procesen la misma fila.
import type { Pool, PoolClient } from 'pg';
import {
  agentExtension, callRecordingPayload, counterpartNumber, decodeIndex, direction, eventFromPayload, InvalidEvent, isExtension,
  isInternal, startedAt, whatsappExternalId, whatsappIsRecorded, type CallRecordingEvent, type WhatsAppCallEvent,
} from './events.ts';
import { loadDirectoryIndex, matchPhone } from './contacts.ts';
import { InvalidPhone, toE164, tryE164 } from './phone.ts';
import type { TranscriptionEngine } from './transcription.ts';
import { madridDay, partiesFromRecording, type VdriveClient } from './vdrive.ts';

export const TRANSCRIPTION_BACKOFF_SECONDS = [60, 300, 900];
export const MAX_TRANSCRIPTION_ATTEMPTS = 3;
const INBOX_MAX_ATTEMPTS = 10;
const ANSWERED = new Set(['ANSWER', 'ANSWERED']);
const RECONCILE_GRACE_MS = 24 * 3600_000;
const STALE_TRANSCRIPTION_MS = 2 * 3600_000;

export type InboxKind = 'callrecording' | 'report' | 'whatsapp_call';

// --- Alertas a tecnología ---------------------------------------------------------------------

/** Sin datos personales: solo identificadores internos y de Netelip. */
export async function notifyTech(subject: string, detail: Record<string, unknown>): Promise<void> {
  console.error('[netelip-alerta]', subject, JSON.stringify(detail));
  const url = process.env.NETELIP_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${subject}\n${JSON.stringify(detail)}` }), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error('[netelip-alerta] No se pudo enviar la alerta:', (error as Error).message);
  }
}

// --- Bandeja del receptor ---------------------------------------------------------------------

export async function acceptInbox(pool: Pool, kind: InboxKind, payload: unknown): Promise<number> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO netelip_inbox(kind, payload) VALUES ($1, $2) RETURNING id', [kind, JSON.stringify(payload)]);
  return Number(rows[0].id);
}

type InboxRow = { id: string; kind: InboxKind; payload: Record<string, unknown>; received_at: Date; attempts: number };

/** Procesa un lote de la bandeja. Devuelve cuántas filas se procesaron con éxito. */
export async function processInbox(pool: Pool, limit = 20): Promise<number> {
  const { rows } = await pool.query<InboxRow>(
    `UPDATE netelip_inbox SET attempts = attempts + 1, next_attempt_at = NOW() + INTERVAL '5 minutes'
     WHERE id IN (SELECT id FROM netelip_inbox WHERE status = 'pending' AND next_attempt_at <= NOW()
                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, payload, received_at, attempts`,
    [limit],
  );
  let done = 0;
  for (const row of rows) {
    try {
      if (row.kind === 'callrecording') await ingestCallRecording(pool, row.payload as unknown as CallRecordingEvent, row.received_at);
      else if (row.kind === 'whatsapp_call') await ingestWhatsAppCall(pool, row.payload as unknown as WhatsAppCallEvent, row.received_at);
      else await storeCallReport(pool, row.payload, row.received_at);
      // Las URL con token ya están en la transcripción (o no se necesitan): fuera de la bandeja.
      await pool.query(
        `UPDATE netelip_inbox SET status = 'done', processed_at = NOW(), last_error = NULL,
           payload = payload - 'url_download' - 'url_audio' - 'recording_url' WHERE id = $1`,
        [row.id],
      );
      done += 1;
    } catch (error) {
      const final = row.attempts >= INBOX_MAX_ATTEMPTS;
      const message = (error as Error).message.slice(0, 2000);
      await pool.query(
        `UPDATE netelip_inbox SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END, last_error = $3,
           next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 30 * POWER(2, attempts))) WHERE id = $1`,
        [row.id, final, message],
      );
      console.error(`[netelip] Error procesando la bandeja ${row.id} (${row.kind}):`, message);
      if (final) await notifyTech('Evento de Netelip sin procesar', { inbox_id: row.id, kind: row.kind, attempts: row.attempts, error: message.slice(0, 500) });
    }
  }
  return done;
}

// --- Ingesta ----------------------------------------------------------------------------------

type NewCall = {
  externalId: string; via: 'phone' | 'whatsapp'; direction: 'inbound' | 'outbound'; occurredAt: Date; startedAtSource: string;
  counterpartPhone: string; phoneE164: string | null; waUserId: string | null; agentExtension: string | null;
  durationSeconds: number; callStatus: string; audioRef: string; receivedAt: Date; sourceUrl: string | null;
};

/** Crea la llamada y su transcripción pendiente. null si el id externo ya existía (sin modificarla). */
async function insertCall(pool: Pool, call: NewCall): Promise<number | null> {
  const index = await loadDirectoryIndex(pool);
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`netelip:${call.externalId}`]);
    const exists = await client.query('SELECT 1 FROM netelip_calls WHERE external_id = $1', [call.externalId]);
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    // Sin número (oculto o anónimo) no hay clave de identidad: sin contacto ni identidad pendiente.
    const match = call.phoneE164 || !call.waUserId ? matchPhone(index, call.phoneE164) : { status: 'unknown' as const, client_id: null, lead_id: null };
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO netelip_calls (external_id, via, direction, occurred_at, started_at_source, counterpart_phone, phone_e164,
         counterpart_wa_user_id, contact_status, client_id, lead_id, agent_extension, duration_seconds, call_status, audio_ref,
         received_at, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12,$13,$14,$15,$16, CASE WHEN $9 = 'matched' THEN NOW() END)
       RETURNING id`,
      [call.externalId, call.via, call.direction, call.occurredAt, call.startedAtSource, call.counterpartPhone, call.phoneE164,
        call.waUserId, match.status, match.client_id, match.lead_id, call.agentExtension, call.durationSeconds, call.callStatus,
        call.audioRef, call.receivedAt],
    );
    const callId = Number(rows[0].id);
    await client.query('INSERT INTO netelip_call_transcriptions (call_id, source_url) VALUES ($1, $2)', [callId, call.sourceUrl]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ msg: 'netelip_call_created', external_id: call.externalId, call_id: callId, via: call.via, contact_status: match.status }));
    return callId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function ingestCallRecording(pool: Pool, event: CallRecordingEvent, receivedAt: Date): Promise<number | null> {
  if (isInternal(event)) return null;
  const raw = counterpartNumber(event);
  let phoneE164: string | null = null;
  try {
    phoneE164 = toE164(raw);
  } catch (error) {
    if (!(error instanceof InvalidPhone)) throw error;
    console.warn(JSON.stringify({ msg: 'netelip_phone_not_normalizable', external_id: event.uniqueid }));
  }
  const start = startedAt(event, new Date(receivedAt));
  return insertCall(pool, {
    externalId: event.uniqueid, via: 'phone', direction: direction(event), occurredAt: start.at, startedAtSource: start.source,
    counterpartPhone: raw || 'anonymous', phoneE164, waUserId: null, agentExtension: agentExtension(event),
    durationSeconds: event.duration, callStatus: event.status, audioRef: event.file, receivedAt: new Date(receivedAt),
    sourceUrl: event.url_download,
  });
}

/** Igual que con Netelip: solo las llamadas contestadas y grabadas tras el aviso completo. */
export async function ingestWhatsAppCall(pool: Pool, event: WhatsAppCallEvent, receivedAt: Date): Promise<number | null> {
  if (!ANSWERED.has(event.status) || !whatsappIsRecorded(event)) return null;
  let phoneE164 = tryE164(event.customer_phone);
  if (!phoneE164 && event.customer_wa_user_id) {
    // Meta puede enviar solo el BSUID: se reutiliza el teléfono de una llamada anterior del mismo usuario.
    const previous = await pool.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM netelip_calls WHERE counterpart_wa_user_id = $1 AND phone_e164 IS NOT NULL ORDER BY id LIMIT 1',
      [event.customer_wa_user_id],
    );
    phoneE164 = previous.rows[0]?.phone_e164 || null;
  }
  return insertCall(pool, {
    externalId: whatsappExternalId(event), via: 'whatsapp', direction: event.direction, occurredAt: new Date(event.started_at * 1000),
    startedAtSource: 'asterisk', counterpartPhone: event.customer_phone || `wa:${event.customer_wa_user_id}`, phoneE164,
    waUserId: event.customer_wa_user_id, agentExtension: event.agent, durationSeconds: event.duration, callStatus: event.status,
    audioRef: event.recording!, receivedAt: new Date(receivedAt), sourceUrl: event.recording_url,
  });
}

// --- Transcripción ----------------------------------------------------------------------------

/** Un intento de transcripción de la siguiente llamada pendiente. Devuelve el resultado o null si no había. */
export async function processNextTranscription(pool: Pool, engine: TranscriptionEngine): Promise<string | null> {
  // `processing` con plazo vencido: el proceso se cayó a mitad; se reintenta.
  const { rows } = await pool.query<{ call_id: string; attempts: number; source_url: string | null; external_id: string; direction: string; via: string; audio_ref: string }>(
    `UPDATE netelip_call_transcriptions t SET status = 'processing', next_attempt_at = NOW() + INTERVAL '35 minutes', updated_at = NOW()
     FROM netelip_calls c
     WHERE c.id = t.call_id AND t.call_id = (
       SELECT call_id FROM netelip_call_transcriptions WHERE status IN ('pending','processing') AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING t.call_id, t.attempts, t.source_url, c.external_id, c.direction, c.via, c.audio_ref`,
  );
  if (!rows.length) return null;
  const job = rows[0];
  const attempt = job.attempts + 1;
  // Progreso: como mucho una escritura cada 2 s.
  let lastWrite = 0;
  const onProgress = (percent: number) => {
    if (Date.now() - lastWrite < 2000) return;
    lastWrite = Date.now();
    void pool.query("UPDATE netelip_call_transcriptions SET progress = $2 WHERE call_id = $1 AND status = 'processing'", [job.call_id, Math.max(0, Math.min(100, percent))]).catch(() => undefined);
  };
  await pool.query('UPDATE netelip_call_transcriptions SET progress = 0 WHERE call_id = $1', [job.call_id]);
  try {
    // En las salientes de Netelip el aviso (`announce`) suena al conectar y queda dentro de la grabación.
    const avisoInRecording = job.via === 'phone' && job.direction === 'outbound' && Boolean(process.env.NETELIP_AVISO_ANNOUNCE);
    // Estéreo: se supone que el canal izquierdo es quien origina la llamada (el agente en las salientes).
    // PENDIENTE de confirmar con una llamada real; si es al revés, NETELIP_STEREO_LEFT=callee.
    const callerIsAgent = job.direction === 'outbound';
    const leftIsCaller = process.env.NETELIP_STEREO_LEFT !== 'callee';
    const channelSpeakers: [string, string] = (callerIsAgent === leftIsCaller) ? ['agente', 'cliente'] : ['cliente', 'agente'];
    const transcript = await engine.transcribe({ externalId: job.external_id, downloadUrl: job.source_url, audioRef: job.audio_ref, onProgress, avisoInRecording, channelSpeakers });
    await pool.query(
      `UPDATE netelip_call_transcriptions SET status = 'completed', engine = $2, language = $3, text = $4, segments = $5,
         attempts = $6, last_error = NULL, source_url = NULL, progress = 100, updated_at = NOW(), completed_at = NOW()
       WHERE call_id = $1`,
      [job.call_id, transcript.engine, transcript.language, transcript.text, transcript.segments ? JSON.stringify(transcript.segments) : null, attempt],
    );
    console.log(JSON.stringify({ msg: 'netelip_transcription_completed', call_id: job.call_id, chars: transcript.text.length }));
    return 'completed';
  } catch (error) {
    const final = attempt >= MAX_TRANSCRIPTION_ATTEMPTS;
    const message = (error as Error).message.slice(0, 2000);
    const delay = TRANSCRIPTION_BACKOFF_SECONDS[Math.min(attempt - 1, TRANSCRIPTION_BACKOFF_SECONDS.length - 1)];
    await pool.query(
      `UPDATE netelip_call_transcriptions SET attempts = $2, last_error = $3, engine = $4, updated_at = NOW(),
         status = CASE WHEN $5 THEN 'failed' ELSE 'pending' END, progress = NULL,
         source_url = CASE WHEN $5 THEN NULL ELSE source_url END,
         next_attempt_at = NOW() + make_interval(secs => $6)
       WHERE call_id = $1`,
      [job.call_id, attempt, message, engine.name, final, delay],
    );
    console.error(JSON.stringify({ msg: 'netelip_transcription_failed', call_id: job.call_id, attempt, final, error: message.slice(0, 300) }));
    if (final) await notifyTech('Transcripción de llamada fallida', { call_id: job.call_id, external_id: job.external_id, attempts: attempt, error: message.slice(0, 500) });
    return final ? 'failed' : 'retrying';
  }
}

// --- Informe de llamadas y conciliación -------------------------------------------------------

/**
 * Id de la llamada si el informe lo trae (`uniqueid`, o `ID` en el informe real de API Voice, comprobado el
 * 15/10/2026); si no, inicio + origen + destino.
 */
export function reportKey(row: Record<string, unknown>): string | null {
  const uniqueid = String(row.uniqueid ?? row.ID ?? '').trim();
  if (uniqueid) return uniqueid;
  const start = String(row.startdate ?? '').trim();
  if (start && (row.src || row.dst)) return `rep:${start}|${row.src ?? ''}|${row.dst ?? ''}`;
  return null;
}

/**
 * Guarda el informe de llamadas. API Voice lo documenta con el índice `calls` (startdate, src, dst,
 * status, duration…), sin uniqueid ni audio. Acepta una lista, un objeto con la lista dentro (también
 * como JSON en texto) o una sola llamada.
 */
export async function storeCallReport(pool: Pool, data: unknown, receivedAt: Date): Promise<number> {
  let rows: unknown[];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === 'object') {
    const decoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, decodeIndex(value)]));
    const lists = Object.values(decoded).filter(Array.isArray);
    rows = lists.length ? lists[0] as unknown[] : [decoded];
  } else rows = [];
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = reportKey(row as Record<string, unknown>);
    if (!key) continue;
    await pool.query(
      `INSERT INTO netelip_call_reports (report_key, raw, received_at) VALUES ($1, $2, $3)
       ON CONFLICT (report_key) DO UPDATE SET raw = EXCLUDED.raw`,
      [key, JSON.stringify(row), receivedAt],
    );
    count += 1;
  }
  return count;
}

/** Hora local de Madrid → instante UTC (tiene en cuenta el horario de verano). */
function madridToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(guess - (wall - guess));
}

/**
 * Fecha del informe de Netelip («2026-10-15 23:09:46.737705»), en hora de Madrid: comprobado el
 * 15/10/2026 contra el ID (epoch UTC) y el nombre del fichero en vDrive.
 */
export function parseReportDate(value: string): Date | null {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (match) return madridToUtc(+match[1], +match[2], +match[3], +match[4], +match[5], +match[6]);
  match = text.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (match) return madridToUtc(+match[3], +match[2], +match[1], +match[4], +match[5], +match[6]);
  return null;
}

/** Filas del índice `calls` (sin uniqueid ni audio): se cruzan por teléfono y hora. Sin audio no se recuperan. */
async function reconcileWithoutUniqueid(pool: Pool, raw: Record<string, unknown>): Promise<'present' | 'reported' | 'skipped'> {
  const src = String(raw.src ?? '');
  const dst = String(raw.dst ?? '');
  const status = String(raw.status ?? '').toUpperCase();
  const duration = Math.trunc(Number(raw.duration || 0)) || 0;
  if ((isExtension(src) && isExtension(dst)) || (status && !ANSWERED.has(status)) || duration <= 0) return 'skipped';
  const phone = tryE164(isExtension(src) ? dst : src);
  if (!phone) return 'reported';
  const started = parseReportDate(String(raw.startdate ?? ''));
  if (started) {
    const near = await pool.query(
      `SELECT 1 FROM netelip_calls WHERE phone_e164 = $1
       AND occurred_at BETWEEN $2::timestamptz - INTERVAL '180 seconds' AND $2::timestamptz + INTERVAL '180 seconds' LIMIT 1`,
      [phone, started],
    );
    if (near.rowCount) return 'present';
  }
  return 'reported';
}

/**
 * Conciliación: cada llamada grabada del informe de Netelip sin llamada guardada tras 24 h se
 * recupera (si el informe trae datos suficientes) o se reporta a tecnología. Netelip no firma ni
 * documenta reintentos del webhook: no se asume entrega garantizada.
 */
export async function reconcile(pool: Pool, now = new Date()): Promise<Record<string, number>> {
  const summary: Record<string, number> = { present: 0, recovered: 0, reported: 0, skipped: 0 };
  const missing: string[] = [];
  const { rows } = await pool.query<{ report_key: string; raw: Record<string, unknown> }>(
    'SELECT report_key, raw FROM netelip_call_reports WHERE reconciled_at IS NULL AND received_at < $1 ORDER BY received_at',
    [new Date(now.getTime() - RECONCILE_GRACE_MS)],
  );
  for (const { report_key: key, raw } of rows) {
    let result: 'present' | 'recovered' | 'reported' | 'skipped';
    if (!('uniqueid' in raw) && !('ID' in raw)) {
      result = await reconcileWithoutUniqueid(pool, raw);
    } else if ((await pool.query('SELECT 1 FROM netelip_calls WHERE external_id = $1', [key])).rowCount) {
      result = 'present';
    } else if (isExtension(String(raw.src ?? '')) && isExtension(String(raw.dst ?? ''))) {
      result = 'skipped'; // llamada interna: fuera de alcance
    } else if (!(raw.file || raw.URLDownload)) {
      // Informe real de API Voice: trae el ID pero no el audio. Si se contestó y en 24 h no se recuperó
      // desde vDrive, falta una llamada grabada.
      const answered = ['ANSWER', 'ANSWERED'].includes(String(raw.status ?? '').toUpperCase()) && Number(raw.duration) > 0;
      result = answered ? 'reported' : 'skipped';
    } else {
      try {
        result = (await ingestCallRecording(pool, eventFromPayload(raw), now)) ? 'recovered' : 'present';
      } catch (error) {
        if (!(error instanceof InvalidEvent)) throw error;
        result = 'reported';
      }
    }
    if (result === 'reported') missing.push(key);
    await pool.query('UPDATE netelip_call_reports SET reconciled_at = NOW(), reconcile_result = $2 WHERE report_key = $1', [key, result]);
    summary[result] += 1;
  }
  const stale = await pool.query<{ call_id: string; external_id: string }>(
    `SELECT t.call_id, c.external_id FROM netelip_call_transcriptions t JOIN netelip_calls c ON c.id = t.call_id
     WHERE t.status IN ('pending','processing') AND t.created_at < $1 LIMIT 200`,
    [new Date(now.getTime() - STALE_TRANSCRIPTION_MS)],
  );
  if (missing.length || stale.rowCount || summary.recovered) {
    await notifyTech('Conciliación de llamadas de Netelip', { ...summary, missing: missing.slice(0, 200), stale_transcriptions: stale.rows });
  }
  summary.stale_transcriptions = stale.rowCount || 0;
  return summary;
}

// --- Recuperación desde vDrive -----------------------------------------------------------------

const RECOVERY_DELAY_MS = 10 * 60_000;

/**
 * Llamadas contestadas del informe de Netelip que no tienen llamada guardada (p. ej. porque su aviso de
 * grabación no llegó o no se procesó): se busca su grabación en vDrive por el ID y se crea la llamada; la
 * transcripción descarga el audio por esa ruta. Lo que no se encuentre lo reporta la conciliación a 24 h.
 */
export async function recoverFromVdrive(pool: Pool, vdrive: VdriveClient, now = new Date(), preferWithAviso = false): Promise<Record<string, number>> {
  const summary = { recovered: 0, present: 0, not_found: 0 };
  const { rows } = await pool.query<{ report_key: string; raw: Record<string, unknown> }>(
    `SELECT report_key, raw FROM netelip_call_reports
     WHERE reconciled_at IS NULL AND raw ? 'ID' AND lower(raw->>'status') IN ('answer','answered')
       AND COALESCE(NULLIF(raw->>'duration','')::numeric, 0) > 0
       -- El ID empieza por el epoch del inicio: se espera a que la llamada tenga 10 minutos (su aviso ya debería haber llegado).
       AND split_part(report_key, '.', 1) ~ '^[0-9]+$' AND to_timestamp(split_part(report_key, '.', 1)::bigint) < $1
     ORDER BY received_at LIMIT 50`,
    [new Date(now.getTime() - RECOVERY_DELAY_MS)],
  );
  for (const { report_key: id, raw } of rows) {
    const src = String(raw.src ?? '');
    const dst = String(raw.dst ?? '');
    if (isExtension(src) && isExtension(dst)) {
      await pool.query("UPDATE netelip_call_reports SET reconciled_at = NOW(), reconcile_result = 'skipped' WHERE report_key = $1", [id]);
      continue;
    }
    if ((await pool.query('SELECT 1 FROM netelip_calls WHERE external_id = $1', [id])).rowCount) {
      await pool.query("UPDATE netelip_call_reports SET reconciled_at = NOW(), reconcile_result = 'present' WHERE report_key = $1", [id]);
      summary.present += 1;
      continue;
    }
    const epoch = Number(id.split('.')[0]);
    const started = parseReportDate(String(raw.startdate ?? '')) || (Number.isFinite(epoch) ? new Date(epoch * 1000) : now);
    const path = await vdrive.findRecording(id, madridDay(started), preferWithAviso);
    if (!path) { summary.not_found += 1; continue; }
    // El nombre del fichero trae la extensión y el número reales; el `src` del informe es el identificador mostrado.
    const parties = partiesFromRecording(path) || { src: src.replace(/\s*\(.*\)$/, ''), dst };
    const created = await ingestCallRecording(pool, {
      uniqueid: id, src: parties.src, dst: parties.dst, userexten: isExtension(parties.src) ? parties.src : null, status: 'ANSWERED',
      duration: Math.max(0, Math.trunc(Number(raw.duration) || 0)), file: path, url_audio: null, url_download: null,
    }, now);
    await pool.query('UPDATE netelip_call_reports SET reconciled_at = NOW(), reconcile_result = $2 WHERE report_key = $1', [id, created ? 'recovered' : 'present']);
    if (created) {
      summary.recovered += 1;
      console.log(JSON.stringify({ msg: 'netelip_call_recovered_from_vdrive', external_id: id, call_id: created }));
    }
  }
  return summary;
}

// --- Retención (P5) y supresión ---------------------------------------------------------------

/**
 * Mientras P5 no esté decidida los días no se configuran y no se borra nada de las llamadas.
 * La llamada y sus metadatos se conservan siempre: solo caducan el texto y el audio.
 * Los eventos ya procesados de la bandeja (con teléfonos) se borran a los 7 días.
 */
export async function applyRetention(pool: Pool, now: Date, transcriptDays: number | null, audioDays: number | null): Promise<Record<string, number>> {
  const day = 24 * 3600_000;
  const summary = { transcriptions_deleted: 0, audios_pending_deletion: 0, inbox_purged: 0 };
  if (transcriptDays) {
    const result = await pool.query(
      'DELETE FROM netelip_call_transcriptions t USING netelip_calls c WHERE t.call_id = c.id AND c.occurred_at < $1',
      [new Date(now.getTime() - transcriptDays * day)],
    );
    summary.transcriptions_deleted = result.rowCount || 0;
  }
  if (audioDays) {
    const result = await pool.query(
      `INSERT INTO netelip_audio_deletion_requests (call_id, audio_ref, reason)
       SELECT id, audio_ref, 'retention' FROM netelip_calls WHERE occurred_at < $1 ON CONFLICT (audio_ref) DO NOTHING`,
      [new Date(now.getTime() - audioDays * day)],
    );
    summary.audios_pending_deletion = result.rowCount || 0;
  }
  const purged = await pool.query("DELETE FROM netelip_inbox WHERE status = 'done' AND processed_at < $1", [new Date(now.getTime() - 7 * day)]);
  summary.inbox_purged = purged.rowCount || 0;
  return summary;
}

export type ErasureTarget = { callId: number } | { phone: string } | { clientId: string } | { leadId: string };

/**
 * Supresión (derecho de supresión u oposición a la grabación, P7): borra las transcripciones y deja
 * cada audio pendiente de borrar en vDrive. La fila de la llamada se conserva sin texto.
 */
export async function eraseCalls(pool: Pool, target: ErasureTarget): Promise<{ calls: number; transcriptions_deleted: number; audios_pending_deletion: number }> {
  const [where, value] = 'callId' in target ? ['id = $1', target.callId]
    : 'phone' in target ? ['phone_e164 = $1', toE164(target.phone)]
      : 'clientId' in target ? ['client_id = $1', target.clientId] : ['lead_id = $1::uuid', target.leadId];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const calls = await client.query<{ id: string }>(`SELECT id FROM netelip_calls WHERE ${where} FOR UPDATE`, [value]);
    const ids = calls.rows.map((row) => row.id);
    const deleted = await client.query('DELETE FROM netelip_call_transcriptions WHERE call_id = ANY($1::bigint[])', [ids]);
    const queued = await client.query(
      `INSERT INTO netelip_audio_deletion_requests (call_id, audio_ref, reason)
       SELECT id, audio_ref, 'erasure' FROM netelip_calls WHERE id = ANY($1::bigint[]) ON CONFLICT (audio_ref) DO NOTHING`,
      [ids],
    );
    await client.query('COMMIT');
    return { calls: ids.length, transcriptions_deleted: deleted.rowCount || 0, audios_pending_deletion: queued.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Para el receptor: valida el cuerpo de un evento `callrecording` antes de guardarlo en la bandeja. */
export function parseCallRecording(fields: Record<string, unknown> | unknown[]): CallRecordingEvent {
  return eventFromPayload(callRecordingPayload(fields));
}
