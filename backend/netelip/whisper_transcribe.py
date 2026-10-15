"""Transcribe un audio con faster-whisper e imprime JSON en stdout (motor `local_whisper`).

Uso: python whisper_transcribe.py <audio>
Requisitos: pip install faster-whisper numpy, y ffmpeg en el PATH.
Variables:
  WHISPER_MODEL               por defecto «large-v3-turbo» (más preciso en español que «medium»)
  WHISPER_LANGUAGE            por defecto «es»
  WHISPER_HOTWORDS            nombres propios que debe reconocer; por defecto «Grupo LYN»
  WHISPER_BEAM_SIZE           por defecto 5
  WHISPER_SKIP_QUIET_LEADIN   «1»: empieza donde arranca la conversación (salientes con aviso, ver abajo)
  WHISPER_AVISO_TEXT          texto del aviso de grabación: los segmentos que lo repiten se descartan
  WHISPER_DIARIZE             «0» desactiva la separación agente/cliente en mono (activa por defecto)
  WHISPER_CHANNEL_SPEAKERS    grabación estéreo: quién habla en cada canal, p. ej. «agente,cliente».
                              Cada canal se transcribe por separado y los turnos se intercalan por tiempo.

Parámetros medidos el 15/10/2026 con una llamada real a un móvil (8 kHz) leyendo un texto conocido:
  medium con VAD (configuración anterior) ≈ 57 % de palabras acertadas; large-v3-turbo saltando el aviso,
  sin VAD y sin repeticiones ≈ 72–76 %. El filtro de silencios y un contexto (initial_prompt) largo
  empeoraban el resultado.

Mientras transcribe escribe «PROGRESS <0-100>» en stderr, para la barra de progreso del Dashboard.
No separa hablantes. Necesita varios GB de RAM: no ejecutar en el servidor de producción actual.
"""

import json
import os
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000

# Frases que Whisper inventa en silencios o al final del audio (vienen de subtítulos de vídeos con los que
# se entrenó). Un segmento que solo contiene una de ellas se descarta.
HALLUCINATIONS = (
    "gracias por ver el video", "gracias por ver el vídeo", "gracias por ver", "suscríbete",
    "subtítulos realizados por la comunidad de amara.org", "subtitulado por la comunidad de amara.org",
    "¡gracias!", "gracias.", "gracias por su atención",
)


# Nombre de la empresa mal reconocido («Grupo Lin», «Grupo Lean»…) → «Grupo LYN».
COMPANY = __import__("re").compile(r"\bgrupo\s+(lyn|lin|lean|blin|line|lynn|link|lyon|ling|líneas?)\b", __import__("re").I)
# Frases que solo dice quien llama de parte de la empresa: identifican la voz de Grupo LYN.
AGENT_CUES = __import__("re").compile(r"\bgrupo lyn\b|\ble llam(o|amos) de\b|\bde parte de\b", __import__("re").I)


def fix_company(text: str) -> str:
    return COMPANY.sub("Grupo LYN", text)


def voice_features(audio: np.ndarray) -> np.ndarray:
    """Huella acústica de un tramo: forma del espectro (cepstro), nivel y energía en bandas alta y baja.

    En una grabación mono las dos voces llegan por caminos distintos (el agente por VoIP, el cliente por la
    red telefónica o móvil) y su espectro se distingue bien aunque compartan canal.
    """
    n, hop = 1024, 512
    if len(audio) < n:
        audio = np.pad(audio, (0, n - len(audio)))
    frames = np.lib.stride_tricks.sliding_window_view(audio, n)[::hop] * np.hanning(n)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2 + 1e-10
    energy = spec.sum(axis=1)
    spec = spec[energy > np.percentile(energy, 40)]
    freqs = np.fft.rfftfreq(n, 1 / SAMPLE_RATE)
    band = freqs <= 4000                      # la grabación es telefónica: nada útil por encima de 4 kHz
    spec, freqs = spec[:, band], freqs[band]
    edges = np.linspace(0, len(freqs), 25).astype(int)
    bands = np.stack([np.log(spec[:, a:b]).mean(axis=1) for a, b in zip(edges[:-1], edges[1:])], axis=1)
    dct = np.cos(np.pi / 24 * (np.arange(24)[:, None] + 0.5) * np.arange(1, 13)[None, :])
    total = spec.sum(axis=1)
    hi = (spec[:, freqs > 3000].sum(axis=1) / total).mean()
    lo = (spec[:, freqs < 300].sum(axis=1) / total).mean()
    return np.concatenate([(bands @ dct).mean(axis=0), [10 * np.log10(total).mean(), np.log(hi), np.log(lo)]])


MIN_LOWBAND_GAP = 0.15


def label_speakers(audio: np.ndarray, rows: list[dict]) -> None:
    """Asigna «agente» o «cliente» a cada segmento de una grabación mono (dos voces, k-medias en 2 grupos).

    La señal más fiable es la energía por debajo de 300 Hz: la red móvil la recorta y la voz por VoIP la
    conserva. Medido el 15/10/2026: en un diálogo agente (PC) / cliente (móvil) los grupos difieren más de
    20 puntos; con una sola voz, menos de 10. Si los grupos difieren menos de MIN_LOWBAND_GAP no son dos
    voces distintas y no se etiqueta. Es GRUPO LYN el grupo que dice las frases de AGENT_CUES; sin pistas
    en el texto, el de más energía grave (VoIP).
    """
    usable = [r for r in rows if r["end"] - r["start"] >= 0.6]
    if len(usable) < 2:
        return
    X = np.stack([voice_features(audio[int(r["start"] * SAMPLE_RATE):int(r["end"] * SAMPLE_RATE)]) for r in usable])
    Z = (X - X.mean(0)) / (X.std(0) + 1e-9)
    dist = ((Z[:, None] - Z[None]) ** 2).sum(-1)
    i, j = np.unravel_index(dist.argmax(), dist.shape)
    centers = Z[[i, j]]
    for _ in range(50):
        groups = ((Z[:, None] - centers[None]) ** 2).sum(-1).argmin(1)
        centers = np.stack([Z[groups == k].mean(0) if (groups == k).any() else centers[k] for k in (0, 1)])
    if len(set(groups)) < 2:
        return
    lowband = [np.exp(X[groups == k, -1]).mean() for k in (0, 1)]
    if abs(lowband[0] - lowband[1]) < MIN_LOWBAND_GAP:
        return
    cue = [sum(bool(AGENT_CUES.search(r["text"])) for r, g in zip(usable, groups) if g == k) for k in (0, 1)]
    agent = int(np.argmax(cue)) if cue[0] != cue[1] else int(np.argmax(lowband))
    for r, g in zip(usable, groups):
        r["speaker"] = "agente" if g == agent else "cliente"


def _words(text: str) -> list[str]:
    import re
    import unicodedata
    clean = unicodedata.normalize("NFD", text.lower())
    return re.findall(r"[a-z0-9]+", "".join(c for c in clean if unicodedata.category(c) != "Mn"))


AVISO_WORDS = set(_words(os.environ.get("WHISPER_AVISO_TEXT", "")))


def is_aviso(text: str) -> bool:
    """El aviso de grabación también queda en la grabación: no lo dijo ninguno de los interlocutores."""
    words = _words(text)
    return bool(AVISO_WORDS) and len(words) >= 3 and sum(w in AVISO_WORDS for w in words) / len(words) >= 0.7


def is_hallucination(text: str) -> bool:
    clean = text.strip().lower().strip(" .,!¡?¿")
    return any(clean == h.strip(" .,!¡?¿") for h in HALLUCINATIONS)


def channel_count(path: str) -> int:
    proc = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                           "-of", "csv=p=0", path], capture_output=True, text=True, check=False)
    try:
        return int(proc.stdout.strip() or 1)
    except ValueError:
        return 1


def decode_16k(path: str, channel: int | None = None) -> np.ndarray:
    """Audio → float32 16 kHz mono. Con `channel` se extrae solo ese canal (0 izquierdo, 1 derecho).

    El decodificador de faster-whisper (PyAV) no es compatible con todas las versiones de ffmpeg.
    """
    filters = ["-af", f"pan=mono|c0=c{channel}"] if channel is not None else ["-ac", "1"]
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, *filters, "-f", "s16le", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True, check=False,
    )
    if proc.returncode != 0:
        sys.exit(f"ffmpeg no pudo decodificar el audio: {proc.stderr.decode()[:200]}")
    return np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0


def quiet_leadin(audio: np.ndarray, max_skip: float = 20.0, drop_db: float = 12.0) -> float:
    """Segundos iniciales muy por debajo del nivel de la conversación.

    En las salientes Netelip graba desde que conecta y el aviso (`announce`) suena al destino en ese
    momento: queda dentro de la grabación, atenuado, y hace que Whisper entre en bucle repitiéndolo.
    Se salta hasta el primer medio segundo seguido a nivel de conversación, con 0,3 s de margen.
    """
    win = int(0.1 * SAMPLE_RATE)
    frames = audio[: len(audio) // win * win].reshape(-1, win)
    if len(frames) < 10:
        return 0.0
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    loud = db > np.percentile(db, 80) - drop_db
    for i in range(len(loud) - 5):
        if loud[i:i + 5].all():
            return max(0.0, min(max_skip, i * 0.1 - 0.3))
    return 0.0


def transcribe(model: WhisperModel, audio: np.ndarray, start: float, *, single_voice: bool, progress) -> list[dict]:
    """Segmentos de un canal. Con una sola voz por canal hay silencios largos (cuando habla el otro):
    el filtro de silencios evita que Whisper invente texto en ellos."""
    # clip_timestamps solo si hay que saltar algo: combinado con el filtro de silencios recorta el principio.
    extra = {"clip_timestamps": [start]} if start > 0 else {}
    if single_voice:
        # Descarta texto inventado en silencios de más de 2 s. Sin el filtro de silencios (mono) se come
        # frases reales, así que solo se usa por canal.
        extra.update(word_timestamps=True, hallucination_silence_threshold=2.0)
    segments, _info = model.transcribe(
        audio, language=os.environ.get("WHISPER_LANGUAGE", "es"), **extra,
        beam_size=int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        hotwords=os.environ.get("WHISPER_HOTWORDS", "Grupo LYN") or None,
        # Sin arrastrar el texto anterior y sin repetir n-gramas: evita los bucles en audio telefónico.
        condition_on_previous_text=False, no_repeat_ngram_size=3, repetition_penalty=1.2,
        vad_filter=single_voice,
        vad_parameters={"threshold": 0.3, "min_silence_duration_ms": 800, "speech_pad_ms": 300} if single_voice else None,
    )
    rows = []
    for s in segments:  # generador: transcribe a medida que se recorre
        if not is_hallucination(s.text) and not is_aviso(s.text):
            rows.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": fix_company(s.text.strip())})
        progress(s.end)
    return rows


def main() -> None:
    language = os.environ.get("WHISPER_LANGUAGE", "es")
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8")
    path = sys.argv[1]
    speakers = [v.strip() for v in os.environ.get("WHISPER_CHANNEL_SPEAKERS", "").split(",") if v.strip()]
    stereo = channel_count(path) >= 2 and len(speakers) == 2
    channels = [(0, speakers[0]), (1, speakers[1])] if stereo else [(None, None)]
    skip = os.environ.get("WHISPER_SKIP_QUIET_LEADIN") == "1"
    print("PROGRESS 1", file=sys.stderr, flush=True)
    rows, skipped = [], 0.0
    for index, (channel, speaker) in enumerate(channels):
        audio = decode_16k(path, channel)
        channel_rows = []
        total = max(len(audio) / SAMPLE_RATE, 0.001)
        start = quiet_leadin(audio) if skip and not stereo else 0.0
        skipped = max(skipped, start)
        def progress(end: float, index=index, total=total) -> None:
            done = (index + min(1.0, end / total)) / len(channels)
            print(f"PROGRESS {min(99, int(done * 100))}", file=sys.stderr, flush=True)
        for row in transcribe(model, audio, start, single_voice=stereo, progress=progress):
            channel_rows.append({**row, "speaker": speaker})
        if not stereo and os.environ.get("WHISPER_DIARIZE", "1") != "0":
            label_speakers(audio, channel_rows)
        rows.extend(channel_rows)
    rows.sort(key=lambda r: r["start"])
    names = {"agente": "Grupo LYN", "cliente": "Cliente"}
    labelled = any(r.get("speaker") for r in rows)
    text = "\n".join(f"{names.get(r.get('speaker'), 'Desconocido')}: {r['text']}" for r in rows) if labelled else " ".join(r["text"] for r in rows)
    print(json.dumps({"language": language, "text": text.strip(), "segments": rows, "stereo": stereo,
                      "skipped_seconds": round(skipped, 1)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
