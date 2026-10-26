// Controlador de API Voice: aviso → grabación → conexión (opción 1 de P2).
//
// En cada paso de la llamada Netelip hace un POST (multipart) a la «URL de control» con los datos de
// la llamada y el resultado del comando anterior (`command`, `description`, `statuscode`,
// `statuscall`…). La respuesta es un JSON `{command, options, userfield}`; el paso viaja en `userfield`.
//
// Garantías:
// - Entrantes: `speak` del aviso → solo si terminó bien, `record` → `dial` a la extensión.
//   Si el aviso falla, se conecta SIN grabar (criterio «Fallo del aviso»).
// - Salientes: `callerid` (si está configurado) → `record` (empieza al conectar) → `dial` al número con
//   `announce` del aviso, que suena al destino antes de la conexión. Sin locución configurada no se graba.
//   API Voice no hereda el identificador de la extensión: sin `callerid` la red pública devuelve BUSY.
// - Al terminar la llamada Netelip hace un POST más a la URL de control, sin `command`, con la ruta en vDrive
//   en `description` y `URLDownload` (comprobado con llamadas reales el 15/10/2026). Llega uno por fichero:
//   la llamada sin el aviso (`….mp3`) y, en salientes con `announce`, la llamada con el aviso incluido
//   (`…_announce.mp3`, unos 10 s más). En mono se usa el primero; en estéreo Netelip solo genera el segundo.
//   Si la llamada se contestó con la grabación activa, se genera el mismo evento que envía Netelip.
//
// El estado de cada llamada vive en memoria del proceso: no admite varias instancias del backend
// (requisito de alta disponibilidad pendiente para producción, ver docs/NETELIP_LLAMADAS.md).
import { isExtension, type CallRecordingEvent } from './events.ts';

const CALLER_GONE = new Set(['CANCEL', 'HANGUP']);
const FAILED_STATUS = new Set(['CANCEL', 'CHANUNAVAIL', 'CONGESTION', 'UNKNOW', 'UNKNOWN', 'HANGUP']);

export type ControlConfig = {
  avisoText: string;
  voice: string;                         // voces de Netelip en español: Pedro, Silvia
  avisoAnnounce: string | null;          // «local|<locución>» o «remote|<URL>», para salientes
  inboundRoutes: Record<string, string>; // número (cifras) → extensión o «pstn:<número>»
  defaultExtension: string | null;
  outboundCallerId: string | null;     // «nombre;número» con un número asignado a la cuenta
  recordAudio: 'mono' | 'stereo';      // estéreo: un canal por interlocutor (separa agente y cliente)
  recordNoconnect: boolean;            // graba desde el comando, no desde que conecta la llamada
  ringSeconds: number;
  maxCallSeconds: number;
};

export function controlConfigFromEnv(env: NodeJS.ProcessEnv): ControlConfig {
  let routes: Record<string, string> = {};
  try { routes = JSON.parse(env.NETELIP_CONTROL_ROUTES || '{}'); } catch { routes = {}; }
  return {
    avisoText: String(env.NETELIP_AVISO_TEXT || '').trim(),
    voice: env.NETELIP_AVISO_VOICE || 'Silvia',
    avisoAnnounce: env.NETELIP_AVISO_ANNOUNCE || null,
    inboundRoutes: routes,
    defaultExtension: env.NETELIP_CONTROL_DEFAULT_EXTENSION || null,
    outboundCallerId: env.NETELIP_OUTBOUND_CALLERID || null,
    // 15/10/2026: `,stereo` no generó la grabación de la conversación (solo la del aviso). Por defecto, mono.
    recordAudio: env.NETELIP_RECORD_AUDIO === 'stereo' ? 'stereo' : 'mono',
    recordNoconnect: env.NETELIP_RECORD_NOCONNECT === '1',
    ringSeconds: 30,
    maxCallSeconds: 3600,
  };
}

export type ControlCommand = { command: string; options: string; userfield: string };
export type CallState = {
  outbound?: boolean;
  aviso_ok?: boolean;
  aviso_failed?: boolean;
  recording?: boolean;
  record_failed?: boolean;
  file?: string;
  url_download?: string;
  url_audio?: string;
  answered?: boolean;                  // el `dial` grabado terminó en ANSWER
  duration?: number;                   // durationcallanswered del `dial`
};

const cmd = (command: string, options: string, userfield: string): ControlCommand => ({ command, options, userfield });
const str = (value: unknown) => String(value ?? '').trim();

function failed(req: Record<string, unknown>): boolean {
  const code = str(req.statuscode);
  const status = str(req.statuscall).toUpperCase();
  return (Boolean(code) && !['0', '200'].includes(code) && !code.startsWith('2')) || FAILED_STATUS.has(status);
}

function route(cfg: ControlConfig, dst: string): string | null {
  const digits = dst.replace(/\D/g, '');
  for (const key of [digits, digits.replace(/^34/, ''), '34' + digits]) {
    if (cfg.inboundRoutes[key]) return cfg.inboundRoutes[key];
  }
  return cfg.defaultExtension;
}

const dialOptions = (cfg: ControlConfig, kind: string, destination: string, announce: string | null) =>
  `${kind},${destination},${cfg.ringSeconds},calling,${cfg.maxCallSeconds},${announce || ''}`;

function dialInbound(cfg: ControlConfig, dst: string, recorded: boolean): ControlCommand {
  const target = route(cfg, dst);
  if (!target) return cmd('hangup', '', 'no_route');
  // «pstn:<número>» desvía a un teléfono externo (pruebas sin extensión); si no, es una extensión.
  const [kind, destination] = target.startsWith('pstn:') ? ['pstn', target.slice(5)] : ['extension', target];
  return cmd('dial', dialOptions(cfg, kind, destination, null), recorded ? 'dial' : 'dial_norec');
}

/** La ruta en vDrive (/APIVoice/Record/...) y las URL llegan tras el comando `record`. */
function captureRecording(req: Record<string, unknown>, state: CallState): void {
  const description = str(req.description);
  if (description.startsWith('/')) state.file = description;
  if (req.URLDownload) state.url_download = str(req.URLDownload);
  if (req.URLAudio) state.url_audio = str(req.URLAudio);
}

/** Aviso de grabación terminada: POST sin `command` con la ruta del fichero en vDrive. */
export function isRecordingNotice(req: Record<string, unknown>): boolean {
  return !str(req.command) && str(req.description).startsWith('/') && Boolean(req.URLDownload || req.URLAudio);
}

function eventFromNotice(req: Record<string, unknown>, state: CallState, cfg: ControlConfig): CallRecordingEvent | null {
  const file = str(req.description);
  const withAviso = /_announce\.[a-z0-9]+$/i.test(file);
  if (withAviso !== (cfg.recordAudio === 'stereo') || !state.recording || !state.answered) return null;
  const src = str(req.src);
  return {
    uniqueid: str(req.ID || req.uniqueid), src, dst: str(req.dst), userexten: state.outbound ? src : null,
    status: 'ANSWERED', duration: state.duration || 0, file,
    url_audio: str(req.URLAudio) || null, url_download: str(req.URLDownload) || null,
  };
}

function recordingEvent(req: Record<string, unknown>, state: CallState): CallRecordingEvent | null {
  const answered = str(req.description).toUpperCase() === 'ANSWER';
  if (!(state.recording && answered && state.file)) return null;
  const src = str(req.src);
  const dst = str(req.dst);
  const duration = Math.trunc(Number(req.durationcallanswered || req.durationcall || 0)) || 0;
  return {
    uniqueid: str(req.ID || req.uniqueid), src, dst, userexten: state.outbound ? src : null,
    status: 'ANSWERED', duration: Math.max(duration, 0), file: state.file,
    url_audio: state.url_audio || null, url_download: state.url_download || null,
  };
}

/** Siguiente comando para la llamada. `state` es el estado de esa llamada y se modifica. */
export function nextCommand(req: Record<string, unknown>, state: CallState, cfg: ControlConfig): { response: ControlCommand; event: CallRecordingEvent | null } {
  const step = str(req.userfield);
  const command = str(req.command);
  const src = str(req.src);
  const dst = str(req.dst);
  state.outbound ??= isExtension(src) && !isExtension(dst);
  const reply = (response: ControlCommand, event: CallRecordingEvent | null = null) => ({ response, event });

  // La llamada ya terminó: Netelip solo informa del fichero grabado.
  if (isRecordingNotice(req)) return reply(cmd('hangup', '', 'end'), eventFromNotice(req, state, cfg));

  // Salientes: primero el identificador de llamada, después grabación y conexión.
  const startOutbound = () => (cfg.avisoAnnounce ? cmd('record', `${cfg.recordNoconnect ? 'noconnect' : ''},${cfg.recordAudio}`, 'record') : cmd('dial', dialOptions(cfg, 'pstn', dst, null), 'dial_norec'));

  // Inicio de la llamada.
  if (!command) {
    if (state.outbound) return reply(cfg.outboundCallerId ? cmd('callerid', cfg.outboundCallerId, 'callerid') : startOutbound());
    if (!route(cfg, dst)) return reply(cmd('hangup', '', 'no_route'));
    if (!cfg.avisoText) return reply(dialInbound(cfg, dst, false));
    return reply(cmd('speak', `netelip;${cfg.voice};${cfg.avisoText}`, 'aviso'));
  }

  // El llamante colgó durante el aviso o la grabación: no hay nada que conectar.
  if (command !== 'dial' && CALLER_GONE.has(str(req.statuscall).toUpperCase())) return reply(cmd('hangup', '', 'end'));

  if (command === 'callerid' && state.outbound) return reply(startOutbound());

  if (command === 'speak' && step === 'aviso') {
    if (failed(req)) {
      state.aviso_failed = true;
      return reply(dialInbound(cfg, dst, false));
    }
    state.aviso_ok = true;
    return reply(cmd('record', `${cfg.recordNoconnect ? 'noconnect' : ''},${cfg.recordAudio}`, 'record'));
  }

  if (command === 'record') {
    if (failed(req)) state.record_failed = true;
    else {
      state.recording = true;
      captureRecording(req, state);
    }
    if (state.outbound) return reply(cmd('dial', dialOptions(cfg, 'pstn', dst, cfg.avisoAnnounce), 'dial'));
    return reply(dialInbound(cfg, dst, Boolean(state.recording)));
  }

  if (command === 'dial') {
    captureRecording(req, state);
    // Contestada si Netelip dice ANSWER o informa de segundos de conversación: cuando cuelga quien llama,
    // el resultado llega como statuscall=CANCEL sin `description` aunque se haya hablado (15/10/2026).
    const talked = Math.max(0, Math.trunc(Number(req.durationcallanswered || 0)) || 0);
    if (step === 'dial' && (str(req.description).toUpperCase() === 'ANSWER' || talked > 0)) {
      state.answered = true;
      state.duration = talked || Math.max(0, Math.trunc(Number(req.durationcall || 0)) || 0);
    }
    return reply(cmd('hangup', '', 'end'), step === 'dial' ? recordingEvent(req, state) : null);
  }

  return reply(cmd('hangup', '', 'end'));
}
