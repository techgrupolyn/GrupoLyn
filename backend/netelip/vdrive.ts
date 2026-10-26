// Acceso a vDrive de Netelip (Nextcloud) por WebDAV: listar /APIVoice/Record/<día>/ y descargar grabaciones.
//
// Sirve de respaldo cuando la URLDownload del aviso falta o caduca, y para recuperar llamadas cuyo aviso
// de grabación no se procesó (ver recoverFromVdrive en processing.ts). Credenciales: un usuario de vDrive
// y una contraseña de aplicación de Nextcloud (Ajustes personales › Seguridad), nunca la del panel.

export type VdriveConfig = { baseUrl: string; user: string; appPassword: string };

export function vdriveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VdriveConfig | null {
  const user = String(env.NETELIP_VDRIVE_USER || '').trim();
  const appPassword = String(env.NETELIP_VDRIVE_APP_PASSWORD || '').trim();
  if (!user || !appPassword) return null;
  return { baseUrl: String(env.NETELIP_VDRIVE_URL || 'https://vdrive.netelip.com').replace(/\/+$/, ''), user, appPassword };
}

const TIMEOUT_MS = 60_000;

export class VdriveClient {
  constructor(private readonly cfg: VdriveConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private url(path: string): string {
    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${this.cfg.baseUrl}/remote.php/dav/files/${encodeURIComponent(this.cfg.user)}/${clean}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: 'Basic ' + Buffer.from(`${this.cfg.user}:${this.cfg.appPassword}`).toString('base64'), ...extra };
  }

  /** Nombres de los ficheros de una carpeta (PROPFIND, profundidad 1). Carpeta inexistente → []. */
  async list(dir: string): Promise<string[]> {
    const response = await this.fetchImpl(this.url(dir), {
      method: 'PROPFIND', headers: this.headers({ depth: '1', 'content-type': 'application/xml' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`vDrive PROPFIND: HTTP ${response.status}`);
    return parsePropfind(await response.text());
  }

  async download(path: string): Promise<Buffer> {
    const response = await this.fetchImpl(this.url(path), { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`vDrive descarga: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Ruta de la grabación de una llamada (por su ID de Netelip) en la carpeta de su día, o null. */
  async findRecording(callId: string, day: string, preferWithAviso: boolean): Promise<string | null> {
    const dir = `/APIVoice/Record/${day}`;
    return pickRecording(await this.list(dir), callId, preferWithAviso, dir);
  }
}

/** Nombres de fichero (sin carpetas) de una respuesta multistatus de WebDAV. */
export function parsePropfind(xml: string): string[] {
  const names: string[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/g)) {
    const block = match[0];
    if (/<(?:\w+:)?collection\b/.test(block)) continue;
    const href = block.match(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/)?.[1];
    if (href) names.push(decodeURIComponent(href.split('/').filter(Boolean).pop() || ''));
  }
  return names.filter(Boolean);
}

/**
 * Por llamada hay `…_<ID>.mp3` (sin el aviso) y, en salientes con aviso, `…_<ID>_announce.mp3` (con él).
 * En estéreo Netelip solo genera el segundo. Se prefiere el que pide la configuración y, si falta, el otro.
 */
export function pickRecording(names: string[], callId: string, preferWithAviso: boolean, dir: string): string | null {
  const escaped = callId.replace(/[.]/g, '\\.');
  const plain = names.find((n) => new RegExp(`_${escaped}\\.[a-z0-9]+$`, 'i').test(n));
  const withAviso = names.find((n) => new RegExp(`_${escaped}_announce\\.[a-z0-9]+$`, 'i').test(n));
  const chosen = preferWithAviso ? withAviso || plain : plain || withAviso;
  return chosen ? `${dir}/${chosen}` : null;
}

/**
 * Origen y destino a partir del nombre del fichero: `<aaaa_mm_dd_hh_mm_ss>_<origen>_<destino>_<ID>[_announce].mp3`.
 * Es más fiable que el informe de llamadas, cuyo `src` es el identificador mostrado («34910… (APIVoice <ID>)»).
 */
export function partiesFromRecording(path: string): { src: string; dst: string } | null {
  const match = path.split('/').pop()?.match(/^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_([^_]+)_([^_]+)_\d+\.\d+(?:_announce)?\.[a-z0-9]+$/i);
  return match ? { src: match[1], dst: match[2] } : null;
}

/** Día (aaaa-mm-dd) en hora de Madrid: así nombra Netelip las carpetas de vDrive. */
export function madridDay(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
