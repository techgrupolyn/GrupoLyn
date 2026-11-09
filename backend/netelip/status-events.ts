// Registro de TODAS las llamadas de las extensiones elegidas (NETELIP_REGISTRO_EXTENSIONES), aunque no se
// contesten ni se graben. Fuente: las «notificaciones de estado» de API Voice (índice `call`: ring, answer,
// hangup, busy, noanswer, notavailable), que llegan a la URL de eventos para las extensiones marcadas en el
// panel, salgan o no por API Voice. Los eventos de una llamada se agrupan por `uniqueid`; si la llamada
// tiene grabación, la llamada registrada y la grabada son la misma fila de netelip_calls.
import type { Pool } from 'pg';
import { loadDirectoryIndex, matchPhone } from './contacts.ts';
import { decodeIndex, InvalidEvent, isExtension } from './events.ts';
import { tryE164 } from './phone.ts';

export const STATUS_VALUES = ['ring', 'answer', 'hangup', 'busy', 'noanswer', 'notavailable'] as const;
export type CallStatusValue = typeof STATUS_VALUES[number];
export const CALL_RESULTS = ['contestada', 'no_contestada', 'ocupado', 'colgada', 'no_disponible', 'en_curso'] as const;
export type CallResult = typeof CALL_RESULTS[number];

/** Una llamada registrada y la grabación de esa misma llamada se unen si empezaron con esta diferencia como mucho. */
export const MERGE_WINDOW_SECONDS = 180;

export type StatusEvent = {
  uniqueid: string;
  extension: string;
  status: CallStatusValue;
  at: Date;
  direction: 'inbound' | 'outbound';
  counterpart: string;
  idapivoice: string | null;
};

/** Extensiones cuyas llamadas se registran todas. Vacío: ninguna (solo las grabadas, como hasta ahora). */
export function registeredExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.NETELIP_REGISTRO_EXTENSIONES || '').split(',').map((e) => e.trim()).filter((e) => /^\d{1,6}$/.test(e));
}

/**
 * `userexten` es el usuario SIP de la extensión: la cuenta de Netelip seguida del número de extensión
 * (4711831338115 → 115). También se acepta la extensión sola.
 */
export function extensionOf(userexten: string, extensions: string[]): string | null {
  const value = userexten.replace(/\D/g, '');
  return extensions.find((ext) => value === ext || (value.length > ext.length && value.endsWith(ext))) || null;
}

/** Cuerpo con el índice `call` (y no una grabación). */
export function isStatusNotification(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) && 'call' in data && !('callrecording' in data));
}

/**
 * Evento `call` de una extensión registrada, o null si no hay que registrarlo (otra extensión, llamada
 * interna). Lanza InvalidEvent si el evento no tiene el formato documentado por Netelip.
 */
export function parseStatusEvent(data: Record<string, unknown>, extensions: string[]): StatusEvent | null {
  const inner = decodeIndex(data.call);
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) throw new InvalidEvent('evento `call` sin objeto');
  const call = inner as Record<string, unknown>;
  const str = (key: string) => String(call[key] ?? '').trim();
  const extension = extensionOf(str('userexten'), extensions);
  if (!extension) return null;
  const uniqueid = str('uniqueid');
  if (!uniqueid) throw new InvalidEvent('evento `call` sin uniqueid');
  const status = str('status').toLowerCase() as CallStatusValue;
  if (!STATUS_VALUES.includes(status)) throw new InvalidEvent(`estado de llamada desconocido: ${status || 'vacío'}`);
  // Fecha y hora en GMT.
  const at = new Date(`${str('date')}T${str('time')}Z`);
  if (Number.isNaN(at.getTime())) throw new InvalidEvent('evento `call` sin fecha u hora válidas');
  const src = str('src');
  const dst = str('dst');
  const type = str('type').toLowerCase();
  const direction = type === 'inbound' || type === 'outbound' ? type : (isExtension(src) ? 'outbound' : 'inbound');
  const counterpart = direction === 'outbound' ? dst : src;
  // Entre dos extensiones de Grupo LYN: fuera de alcance, igual que con las grabaciones.
  if (isExtension(counterpart)) return null;
  return { uniqueid, extension, status, at, direction, counterpart, idapivoice: str('idapivoice') || null };
}

export type CallSummary = { result: CallResult; startedAt: Date; answeredAt: Date | null; endedAt: Date | null; durationSeconds: number };

/** Resultado de la llamada a partir de todos sus eventos, en cualquier orden de llegada. */
export function summarize(events: Array<{ status: CallStatusValue; at: Date }>): CallSummary {
  const times = (status: CallStatusValue) => events.filter((e) => e.status === status).map((e) => e.at.getTime());
  const all = events.map((e) => e.at.getTime());
  const answer = times('answer');
  const terminal = [...times('hangup'), ...times('busy'), ...times('noanswer'), ...times('notavailable')];
  const startedAt = new Date(Math.min(...(times('ring').length ? times('ring') : all)));
  const answeredAt = answer.length ? new Date(Math.min(...answer)) : null;
  const endedAt = terminal.length ? new Date(Math.max(...terminal)) : null;
  let result: CallResult;
  if (answeredAt) result = 'contestada';
  else if (times('busy').length) result = 'ocupado';
  else if (times('noanswer').length) result = 'no_contestada';
  else if (times('notavailable').length) result = 'no_disponible';
  else if (times('hangup').length) result = 'colgada';
  else result = 'en_curso';
  const durationSeconds = answeredAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000)) : 0;
  return { result, startedAt, answeredAt, endedAt, durationSeconds };
}

/**
 * Guarda el evento y deja la llamada registrada al día. Si ya existe la grabación de esa llamada (por
 * idapivoice, o misma extensión y teléfono con menos de MERGE_WINDOW_SECONDS de diferencia), se une a
 * ella; si no, se crea una llamada sin grabación ni transcripción.
 */
export async function ingestStatusEvent(pool: Pool, event: StatusEvent, receivedAt: Date): Promise<number> {
  const index = await loadDirectoryIndex(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`netelip-ev:${event.uniqueid}`]);
    await client.query(
      `INSERT INTO netelip_call_events (uniqueid, extension, status, at, direction, counterpart, idapivoice, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (uniqueid, status, at) DO NOTHING`,
      [event.uniqueid, event.extension, event.status, event.at, event.direction, event.counterpart, event.idapivoice, receivedAt]);
    const { rows: events } = await client.query<{ status: CallStatusValue; at: Date; idapivoice: string | null }>(
      'SELECT status, at, idapivoice FROM netelip_call_events WHERE uniqueid = $1', [event.uniqueid]);
    const summary = summarize(events);
    const idapivoice = events.find((e) => e.idapivoice)?.idapivoice || null;
    const phoneE164 = tryE164(event.counterpart);

    let { rows: [call] } = await client.query<{ id: string; audio_ref: string | null }>(
      'SELECT id, audio_ref FROM netelip_calls WHERE event_uniqueid = $1', [event.uniqueid]);
    if (!call) {
      // ¿Ya está la grabación de esta llamada? Primero por el id de API Voice; si no, por extensión, teléfono y hora.
      ({ rows: [call] } = await client.query<{ id: string; audio_ref: string | null }>(
        `SELECT id, audio_ref FROM netelip_calls
         WHERE event_uniqueid IS NULL AND via = 'phone' AND (
           ($1::text IS NOT NULL AND external_id = $1)
           OR (agent_extension = $2 AND (phone_e164 = $3 OR counterpart_phone = $4)
               AND occurred_at BETWEEN $5::timestamptz - make_interval(secs => $6) AND $5::timestamptz + make_interval(secs => $6)))
         ORDER BY (external_id = $1) DESC NULLS LAST, abs(extract(epoch FROM occurred_at - $5::timestamptz)) LIMIT 1`,
        [idapivoice, event.extension, phoneE164, event.counterpart, summary.startedAt, MERGE_WINDOW_SECONDS]));
    }
    let callId: number;
    if (call) {
      callId = Number(call.id);
      // Con grabación, la duración y el inicio son los de la grabación; sin ella, los de los eventos.
      await client.query(
        `UPDATE netelip_calls SET event_uniqueid = $2, resultado = $3,
           occurred_at = CASE WHEN audio_ref IS NULL THEN $4 ELSE occurred_at END,
           duration_seconds = CASE WHEN audio_ref IS NULL THEN $5 ELSE duration_seconds END,
           call_status = CASE WHEN audio_ref IS NULL THEN $3 ELSE call_status END
         WHERE id = $1`,
        [callId, event.uniqueid, summary.result, summary.startedAt, summary.durationSeconds]);
    } else {
      const match = matchPhone(index, phoneE164);
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO netelip_calls (external_id, via, direction, occurred_at, started_at_source, counterpart_phone, phone_e164,
           contact_status, client_id, lead_id, agent_extension, duration_seconds, call_status, audio_ref, received_at, linked_at,
           event_uniqueid, resultado)
         VALUES ($1, 'phone', $2, $3, 'event', $4, $5, $6, $7, $8::uuid, $9, $10, $11, NULL, $12, CASE WHEN $6 = 'matched' THEN NOW() END, $13, $11)
         RETURNING id`,
        [`ev:${event.uniqueid}`, event.direction, summary.startedAt, event.counterpart || 'anonymous', phoneE164, match.status,
          match.client_id, match.lead_id, event.extension, summary.durationSeconds, summary.result, receivedAt, event.uniqueid]);
      callId = Number(row.id);
      console.log(JSON.stringify({ msg: 'netelip_call_registered', call_id: callId, extension: event.extension, contact_status: match.status }));
    }
    await client.query('COMMIT');
    return callId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
