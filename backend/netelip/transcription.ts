// Motores de transcripción (NETELIP_TRANSCRIPTION_ENGINE). La ruta definitiva se decide en P3 (Producto + Legal):
//   gemini           Gemini con la clave de los informes. Sin carga en el servidor; el audio sale a Google.
//   local_whisper    Whisper en un proceso aparte. Pesado en CPU y RAM: mejor en un servidor dedicado.
//   netelip_ai       IA de Netelip (ruta A): pendiente de que el spike confirme cómo se obtiene el texto.
//   none             sin motor: la transcripción queda pendiente.
// Todos obtienen el audio igual (fetchCallAudio): URL del aviso o, si caducó, vDrive.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { callGeminiWithMediaResult } from '../geminiService.ts';
import { VdriveClient, vdriveConfigFromEnv } from './vdrive.ts';

export type Segment = { speaker: string | null; start: number; end: number; text: string };
export type Transcript = { engine: string; language: string; text: string; segments: Segment[] | null };

export type TranscriptionInput = {
  externalId: string;
  downloadUrl: string | null;
  /** Ruta en vDrive: respaldo si la URL falta o caducó. */
  audioRef?: string | null;
  onProgress?: (percent: number) => void;
  /** Salientes con aviso: el aviso queda atenuado al principio de la grabación y hay que saltarlo. */
  avisoInRecording?: boolean;
  /** Grabación estéreo: quién habla en cada canal (izquierdo, derecho). */
  channelSpeakers?: [string, string];
};

export interface TranscriptionEngine {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}

export class TranscriptionError extends Error {}

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

/** Descarga el audio a un temporal. La URL lleva el token de vDrive: nunca se registra. */
export async function downloadAudio(url: string, dir: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new TranscriptionError(`descarga del audio fallida: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_AUDIO_BYTES) throw new TranscriptionError('audio demasiado grande');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new TranscriptionError('audio vacío');
  const ext = String(response.headers.get('content-type') || '').includes('wav') ? 'wav' : 'mp3';
  const file = join(dir, `audio.${ext}`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/** Audio por la URL del aviso; si falta o falla, por su ruta en vDrive (API WebDAV). Común a todos los motores. */
export async function fetchCallAudio(downloadUrl: string | null, audioRef: string | null | undefined, dir: string, vdrive: VdriveClient | null): Promise<string> {
  let urlError: Error | null = null;
  if (downloadUrl) {
    try { return await downloadAudio(downloadUrl, dir); } catch (error) { urlError = error as Error; }
  }
  if (vdrive && audioRef) {
    const file = join(dir, `audio${extname(audioRef) || '.mp3'}`);
    await writeFile(file, await vdrive.download(audioRef), { mode: 0o600 });
    return file;
  }
  throw urlError || new TranscriptionError('sin URL de descarga ni acceso a vDrive: no se puede obtener el audio');
}

/**
 * Ejecuta `NETELIP_WHISPER_COMMAND <fichero>`, que debe imprimir en stdout
 * {"language": "es", "text": "...", "segments": [{start, end, text}]}.
 * Ver backend/netelip/whisper_transcribe.py.
 */
export class WhisperCommandEngine implements TranscriptionEngine {
  readonly name = 'local_whisper';
  /** debugAudioDir: SOLO en local, copia el audio para comparar configuraciones (contiene datos personales). */
  constructor(private readonly command: string, private readonly timeoutMs = 30 * 60_000, private readonly debugAudioDir: string | null = null,
    private readonly vdrive: VdriveClient | null = null) {}

  async transcribe({ externalId, downloadUrl, audioRef, onProgress, avisoInRecording, channelSpeakers }: TranscriptionInput): Promise<Transcript> {
    const dir = await mkdtemp(join(tmpdir(), 'netelip-audio-'));
    try {
      const file = await fetchCallAudio(downloadUrl, audioRef, dir, this.vdrive);
      if (this.debugAudioDir) {
        await mkdir(this.debugAudioDir, { recursive: true, mode: 0o700 });
        await copyFile(file, join(this.debugAudioDir, `${externalId.replace(/[^\w.-]/g, '_')}${extname(file)}`));
      }
      const output = await this.run(file, onProgress, {
        ...(avisoInRecording ? { WHISPER_SKIP_QUIET_LEADIN: '1' } : {}),
        ...(channelSpeakers ? { WHISPER_CHANNEL_SPEAKERS: channelSpeakers.join(',') } : {}),
        ...(process.env.NETELIP_AVISO_TEXT ? { WHISPER_AVISO_TEXT: process.env.NETELIP_AVISO_TEXT } : {}),
        // Su duración limita lo que se salta al principio: así no se pierde el saludo tras el aviso.
        ...(avisoInRecording && process.env.NETELIP_AVISO_FILE ? { WHISPER_AVISO_FILE: process.env.NETELIP_AVISO_FILE } : {}),
      });
      let parsed: { language?: string; text?: string; segments?: Array<{ start: number; end: number; text: string; speaker?: string | null }> };
      try { parsed = JSON.parse(output); } catch { throw new TranscriptionError('salida de Whisper no es JSON'); }
      // Texto vacío no es un fallo: la grabación puede contener solo el aviso o silencio (nadie habló).
      // El script no transcribe los tramos sin voz («no_speech»): en silencio Whisper inventa texto.
      const text = String(parsed.text || '').trim();
      const segments = (parsed.segments || []).map((s) => ({ speaker: s.speaker ?? null, start: Number(s.start), end: Number(s.end), text: String(s.text).trim() }));
      return { engine: this.name, language: parsed.language || 'es', text, segments: segments.length ? segments : null };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private run(file: string, onProgress?: (percent: number) => void, extraEnv: Record<string, string> = {}): Promise<string> {
    const [bin, ...args] = this.command.split(/\s+/).filter(Boolean);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [...args, file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new TranscriptionError('Whisper no terminó a tiempo')); }, this.timeoutMs);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => {
        err += chunk;
        // «PROGRESS <0-100>»: avance que informa el script mientras transcribe.
        const matches = [...String(chunk).matchAll(/PROGRESS (\d+)/g)];
        if (matches.length && onProgress) onProgress(Number(matches[matches.length - 1][1]));
      });
      child.on('error', (error) => { clearTimeout(timer); reject(new TranscriptionError(`no se pudo ejecutar Whisper: ${error.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new TranscriptionError(`Whisper terminó con código ${code}: ${err.slice(-300)}`));
      });
    });
  }
}

const GEMINI_TIMEOUT_MS = 5 * 60_000;

const GEMINI_PROMPT = `Transcribe literalmente, en español, esta llamada telefónica de Grupo LYN con un cliente.
- Al principio puede sonar una locución grabada que avisa de que la llamada se graba: no la transcribas.
- Hablan dos personas: "agente" (Grupo LYN) y "cliente". Si no puedes saber quién habla, usa null.
- Si no hay conversación (solo silencio, ruido, tonos o la locución), devuelve segments vacío. No inventes texto.
Responde solo con JSON: {"language":"es","segments":[{"start":0.0,"end":0.0,"speaker":"agente","text":"..."}]}
start y end en segundos desde el inicio de la grabación.`;

function words(text: string): string[] {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** Mismo criterio que whisper_transcribe.py: el aviso queda en la grabación, pero no lo dijo nadie. */
function isAviso(text: string, avisoWords: Set<string>): boolean {
  const w = words(text);
  return avisoWords.size > 0 && w.length >= 3 && w.filter((x) => avisoWords.has(x)).length / w.length >= 0.7;
}

/** Respuesta de Gemini → Transcript. Descarta el aviso y los segmentos que solo dicen «Grupo LYN» (NET-03). */
export function parseGeminiTranscript(raw: string, avisoText = ''): Transcript {
  let parsed: { language?: string; segments?: Array<{ start?: unknown; end?: unknown; speaker?: unknown; text?: unknown }> };
  try { parsed = JSON.parse(raw); } catch { throw new TranscriptionError('respuesta de Gemini no es JSON'); }
  if (!parsed || !Array.isArray(parsed.segments)) throw new TranscriptionError('respuesta de Gemini sin segments');
  const avisoWords = new Set(words(avisoText));
  const segments: Segment[] = parsed.segments
    .map((s) => {
      const speaker = String(s.speaker ?? '').toLowerCase();
      return { speaker: speaker === 'agente' || speaker === 'cliente' ? speaker : null, start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim() };
    })
    .filter((s) => s.text && !isAviso(s.text, avisoWords) && !words(s.text).every((w) => w === 'grupo' || w === 'lyn'));
  return { engine: 'gemini', language: parsed.language || 'es', text: segments.map((s) => s.text).join(' '), segments: segments.length ? segments : null };
}

/** Gemini (Interactions API, misma clave que los informes). El audio sale a Google: requiere el visto bueno de Legal (P3). */
export class GeminiEngine implements TranscriptionEngine {
  readonly name = 'gemini';
  constructor(private readonly vdrive: VdriveClient | null = null, private readonly call: typeof callGeminiWithMediaResult = callGeminiWithMediaResult) {}

  async transcribe({ downloadUrl, audioRef, onProgress }: TranscriptionInput): Promise<Transcript> {
    const dir = await mkdtemp(join(tmpdir(), 'netelip-audio-'));
    try {
      const file = await fetchCallAudio(downloadUrl, audioRef, dir, this.vdrive);
      onProgress?.(10);
      const audio = { type: 'audio' as const, base64: (await readFile(file)).toString('base64'), mimeType: extname(file) === '.wav' ? 'audio/wav' : 'audio/mpeg' };
      const result = await this.call(GEMINI_PROMPT, [audio], 'flash', undefined, GEMINI_TIMEOUT_MS);
      // Sin Gemini, callGeminiWithMediaResult devuelve un texto local de reserva: nunca se guarda como transcripción.
      if (result.fallback) throw new TranscriptionError(`Gemini no disponible${result.retryable ? ' (temporal)' : ' (clave, cuota o petición rechazada)'}`);
      return parseGeminiTranscript(result.text, process.env.NETELIP_AVISO_TEXT || '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export class NetelipAIEngine implements TranscriptionEngine {
  readonly name = 'netelip_ai';
  async transcribe(): Promise<Transcript> {
    throw new TranscriptionError('Ruta A no implementada: el spike debe confirmar el endpoint de transcripción de Netelip');
  }
}

export function buildEngine(env: NodeJS.ProcessEnv): TranscriptionEngine | null {
  const name = String(env.NETELIP_TRANSCRIPTION_ENGINE || 'none').trim();
  if (name === 'none' || !name) return null;
  if (name === 'netelip_ai') return new NetelipAIEngine();
  if (name === 'gemini') {
    const vdrive = vdriveConfigFromEnv(env);
    return new GeminiEngine(vdrive ? new VdriveClient(vdrive) : null);
  }
  if (name === 'local_whisper') {
    const command = String(env.NETELIP_WHISPER_COMMAND || '').trim();
    if (!command) throw new Error('NETELIP_WHISPER_COMMAND es obligatorio con NETELIP_TRANSCRIPTION_ENGINE=local_whisper');
    const vdrive = vdriveConfigFromEnv(env);
    return new WhisperCommandEngine(command, 30 * 60_000, String(env.NETELIP_DEBUG_AUDIO_DIR || '').trim() || null, vdrive ? new VdriveClient(vdrive) : null);
  }
  throw new Error(`motor de transcripción desconocido: ${name}`);
}
