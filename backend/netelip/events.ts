// Contratos de los eventos que llegan al receptor: grabación de Netelip, informe de llamadas y
// llamada de WhatsApp grabada por Asterisk. Ver docs/NETELIP_LLAMADAS.md.
import { BlockList, isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

// Una extensión de la centralita es corta; un teléfono de red pública tiene 9 cifras o más.
export const EXTENSION_MAX_DIGITS = 6;
// Redes de confianza publicadas por Netelip (Europa y América).
export const NETELIP_TRUSTED_NETWORKS = '185.8.244.0/24,192.99.91.144/29';

export class InvalidEvent extends Error {}

/**
 * Evento válido de Netelip que no crea llamadas. A la «URL eventos de llamada» de API Voice llegan
 * también los índices `call` (ring, answer, hangup…) y `register`: se responden con 200.
 */
export class IgnoredEvent extends Error {
  constructor(readonly index: string, readonly status: string | null = null) { super(index); }
}

const IGNORED_INDEXES = ['call', 'register'];

export type CallRecordingEvent = {
  uniqueid: string;
  src: string;
  dst: string;
  userexten: string | null;
  status: string;
  duration: number;
  file: string;
  url_audio: string | null;
  url_download: string | null;
};

export function isExtension(number: string | null | undefined): boolean {
  const digits = String(number || '').replace(/\D/g, '').length;
  return digits > 0 && digits <= EXTENSION_MAX_DIGITS;
}

/** Llamada entre dos extensiones de Grupo LYN: fuera de alcance. */
export function isInternal(event: Pick<CallRecordingEvent, 'src' | 'dst'>): boolean {
  return isExtension(event.src) && isExtension(event.dst);
}

/** Saliente si la origina una extensión; entrante en otro caso. */
export function direction(event: Pick<CallRecordingEvent, 'src'>): 'inbound' | 'outbound' {
  return isExtension(event.src) ? 'outbound' : 'inbound';
}

export function counterpartNumber(event: CallRecordingEvent): string {
  return direction(event) === 'outbound' ? event.dst : event.src;
}

export function agentExtension(event: CallRecordingEvent): string | null {
  if (event.userexten) return event.userexten;
  return direction(event) === 'outbound' ? event.src : null;
}

/**
 * Inicio de la llamada en UTC y de dónde sale. El evento no trae fecha: el uniqueid de Asterisk es
 * `<epoch>.<secuencia>` en GMT; si no lo es, se aproxima como recepción − duración.
 */
export function startedAt(event: CallRecordingEvent, receivedAt: Date): { at: Date; source: string } {
  const head = event.uniqueid.split('.', 1)[0];
  if (/^\d{10}$/.test(head)) return { at: new Date(Number(head) * 1000), source: 'uniqueid' };
  return { at: new Date(receivedAt.getTime() - event.duration * 1000), source: 'received_minus_duration' };
}

/** Netelip envía cada índice como un campo cuyo valor es un JSON en texto. */
export function decodeIndex(value: unknown): unknown {
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

/**
 * Campos del cuerpo, sea cual sea el formato. Netelip no documenta el Content-Type: API Voice envía
 * multipart/form-data, y los eventos pueden llegar como form-urlencoded o JSON (plano o anidado).
 */
export async function bodyFields(raw: Buffer | string, contentType: string | undefined): Promise<Record<string, unknown> | unknown[]> {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const ctype = String(contentType || '');
  if (ctype.toLowerCase().startsWith('multipart/')) {
    const form = await new Response(new Uint8Array(buffer), { headers: { 'content-type': ctype } }).formData();
    const fields: Record<string, unknown> = {};
    form.forEach((value, key) => { fields[key] = typeof value === 'string' ? value : ''; });
    return fields;
  }
  const text = buffer.toString('utf8').trim();
  if (!text) throw new InvalidEvent('cuerpo vacío');
  if (/^[[{]/.test(text)) {
    try { return JSON.parse(text); } catch (error) { throw new InvalidEvent(`JSON inválido: ${(error as Error).message}`); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Objeto plano del evento `callrecording`, o IgnoredEvent si es otro índice de API Voice. */
export function callRecordingPayload(data: Record<string, unknown> | unknown[]): Record<string, unknown> {
  if (Array.isArray(data) || !data || typeof data !== 'object') throw new InvalidEvent('el cuerpo no es un objeto');
  for (const index of IGNORED_INDEXES) {
    if (index in data && !('callrecording' in data)) {
      const inner = decodeIndex(data[index]);
      const status = inner && typeof inner === 'object' && 'status' in inner ? String((inner as Record<string, unknown>).status) : null;
      throw new IgnoredEvent(index, status);
    }
  }
  const nested = decodeIndex(data.callrecording);
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : data;
}

export function eventFromPayload(data: Record<string, unknown>): CallRecordingEvent {
  const get = (...keys: string[]): string | null => {
    for (const key of keys) {
      for (const candidate of [key, key.toLowerCase()]) {
        const value = data[candidate];
        if (value !== undefined && value !== null && value !== '') return String(value).trim();
      }
    }
    return null;
  };
  const uniqueid = get('uniqueid');
  const src = get('src');
  const dst = get('dst');
  const file = get('file');
  const missing = Object.entries({ uniqueid, src, dst, file }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new InvalidEvent(`faltan campos obligatorios: ${missing.join(', ')}`);
  const durationRaw = get('duration') || '0';
  const duration = Math.trunc(Number(durationRaw));
  if (!Number.isFinite(duration)) throw new InvalidEvent(`duration no numérica: ${durationRaw}`);
  return {
    uniqueid: uniqueid!, src: src!, dst: dst!, file: file!,
    userexten: get('userexten'),
    status: (get('status') || 'UNKNOWN').toUpperCase(),
    duration: Math.max(duration, 0),
    url_audio: get('URLAudio'),
    url_download: get('URLDownload'),
  };
}

// --- WhatsApp Business Calling (vía Asterisk, ver asterisk/ en el repositorio netelip-calls) -------

export type WhatsAppCallEvent = {
  wacid: string;
  direction: 'inbound' | 'outbound';
  customer_phone: string | null;
  customer_wa_user_id: string | null;   // BSUID: Meta puede enviarlo en lugar del teléfono
  agent: string | null;
  started_at: number;                   // epoch UTC
  duration: number;
  status: string;                       // DIALSTATUS de Asterisk
  aviso: string;                        // played | failed: sin aviso completo no hay grabación
  recording: string | null;
  recording_url: string | null;         // enlace firmado para transcribir; no se guarda en la llamada
};

export const whatsappExternalId = (event: Pick<WhatsAppCallEvent, 'wacid'>) => `wa:${event.wacid}`;

/** Solo cuenta como grabada si el aviso sonó completo y hay fichero (criterio «Fallo del aviso»). */
export const whatsappIsRecorded = (event: WhatsAppCallEvent) => event.aviso === 'played' && Boolean(event.recording);

export function parseWhatsAppCall(data: unknown): WhatsAppCallEvent {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InvalidEvent('se esperaba un objeto JSON');
  const body = data as Record<string, unknown>;
  const opt = (value: unknown) => (value === undefined || value === null ? '' : String(value).trim()) || null;
  const wacid = opt(body.wacid);
  if (!wacid) throw new InvalidEvent('falta wacid');
  const dir = String(body.direction || '').trim().toLowerCase();
  if (dir !== 'inbound' && dir !== 'outbound') throw new InvalidEvent(`direction inválida: ${dir}`);
  const phone = opt(body.customer_phone);
  const waUser = opt(body.customer_wa_user_id);
  if (!phone && !waUser) throw new InvalidEvent('falta customer_phone o customer_wa_user_id');
  const started = Math.trunc(Number(body.started_at));
  const duration = Math.trunc(Number(body.duration || 0));
  if (body.started_at === undefined || !Number.isFinite(started) || !Number.isFinite(duration)) throw new InvalidEvent('started_at/duration inválidos');
  return {
    wacid, direction: dir, customer_phone: phone, customer_wa_user_id: waUser, agent: opt(body.agent),
    started_at: started, duration: Math.max(0, duration),
    status: String(body.status || 'UNKNOWN').toUpperCase(),
    aviso: String(body.aviso || 'failed').toLowerCase(),
    recording: opt(body.recording), recording_url: opt(body.recording_url),
  };
}

// --- Autenticación del webhook: Netelip no firma sus notificaciones ---------------------------
// Defensa: HTTPS (Nginx) + IP en las redes de Netelip + token no adivinable en la ruta + conciliación.

const blockLists = new Map<string, BlockList>();

function networks(spec: string): BlockList {
  let list = blockLists.get(spec);
  if (!list) {
    list = new BlockList();
    for (const entry of spec.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [address, prefix] = entry.split('/');
      const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
      if (prefix) list.addSubnet(address, Number(prefix), family);
      else list.addAddress(address, family);
    }
    blockLists.set(spec, list);
  }
  return list;
}

export function ipAllowed(sourceIp: string | undefined, spec: string): boolean {
  const ip = String(sourceIp || '').replace(/^::ffff:/, '');
  const family = isIP(ip);
  if (!family || !spec.trim()) return false;
  return networks(spec).check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
