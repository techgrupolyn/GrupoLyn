// Motores de transcripción. La ruta definitiva se decide en P3 (spike + dictamen de Legal):
//   netelip_ai       IA de Netelip (ruta A): pendiente de que el spike confirme cómo se obtiene el texto.
//   whisper_command  Whisper en un proceso aparte (ruta propia). En producción no cabe en el servidor
//                    actual (1 GB de RAM): solo para local o para un servidor de transcripción dedicado.
//   none             sin motor: la transcripción queda pendiente.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
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

  /** Audio por la URL del aviso; si falta o falla, por su ruta en vDrive (API WebDAV). */
  private async fetchAudio(downloadUrl: string | null, audioRef: string | null | undefined, dir: string): Promise<string> {
    let urlError: Error | null = null;
    if (downloadUrl) {
      try { return await downloadAudio(downloadUrl, dir); } catch (error) { urlError = error as Error; }
    }
    if (this.vdrive && audioRef) {
      const file = join(dir, `audio${extname(audioRef) || '.mp3'}`);
      await writeFile(file, await this.vdrive.download(audioRef), { mode: 0o600 });
      return file;
    }
    throw urlError || new TranscriptionError('sin URL de descarga ni acceso a vDrive: no se puede obtener el audio');
  }

  async transcribe({ externalId, downloadUrl, audioRef, onProgress, avisoInRecording, channelSpeakers }: TranscriptionInput): Promise<Transcript> {
    const dir = await mkdtemp(join(tmpdir(), 'netelip-audio-'));
    try {
      const file = await this.fetchAudio(downloadUrl, audioRef, dir);
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
  if (name === 'local_whisper') {
    const command = String(env.NETELIP_WHISPER_COMMAND || '').trim();
    if (!command) throw new Error('NETELIP_WHISPER_COMMAND es obligatorio con NETELIP_TRANSCRIPTION_ENGINE=local_whisper');
    const vdrive = vdriveConfigFromEnv(env);
    return new WhisperCommandEngine(command, 30 * 60_000, String(env.NETELIP_DEBUG_AUDIO_DIR || '').trim() || null, vdrive ? new VdriveClient(vdrive) : null);
  }
  throw new Error(`motor de transcripción desconocido: ${name}`);
}
