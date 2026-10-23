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
  WHISPER_AVISO_FILE          locución del aviso: su duración limita lo que se salta al principio
  WHISPER_DIARIZE             «0» desactiva la separación agente/cliente en mono (activa por defecto)
  WHISPER_CHANNEL_SPEAKERS    grabación estéreo: quién habla en cada canal, p. ej. «agente,cliente».
                              Cada canal se transcribe por separado y los turnos se intercalan por tiempo.

Parámetros medidos el 15/10/2026 con una llamada real a un móvil (8 kHz) leyendo un texto conocido:
  medium con VAD (configuración anterior) ≈ 57 % de palabras acertadas; large-v3-turbo saltando el aviso,
  sin VAD y sin repeticiones ≈ 72–76 %. El filtro de silencios y un contexto (initial_prompt) largo
  empeoraban el resultado.

Sin voz (solo silencio o ruido de línea) no se llama a Whisper: devuelve texto vacío y «no_speech»,
porque en silencio Whisper inventa texto (QA 22/10/2026: «Grupo LYN», la palabra de `hotwords`).

Mientras transcribe escribe «PROGRESS <0-100>» en stderr, para la barra de progreso del Dashboard.
Necesita varios GB de RAM: no ejecutar en el servidor de producción actual.
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


def lowband_ratio(audio: np.ndarray) -> float:
    """Fracción de la energía por debajo de 300 Hz en los tramos con voz de un fragmento.

    En una grabación mono las dos voces llegan por caminos distintos: la red móvil recorta los graves y la
    voz por VoIP los conserva. Medido el 15/10/2026: entre agente (PC) y cliente (móvil) hay más de 0,15 de
    diferencia; con una sola voz, menos de 0,10.
    """
    n, hop = 1024, 512
    if len(audio) < n:
        audio = np.pad(audio, (0, n - len(audio)))
    frames = np.lib.stride_tricks.sliding_window_view(audio, n)[::hop] * np.hanning(n)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2 + 1e-10
    freqs = np.fft.rfftfreq(n, 1 / SAMPLE_RATE)
    band = freqs <= 4000                      # la grabación es telefónica: nada útil por encima de 4 kHz
    spec, freqs = spec[:, band], freqs[band]
    total = spec.sum(axis=1)
    voiced = total >= np.percentile(total, 40)
    return float((spec[voiced][:, freqs < 300].sum(axis=1) / total[voiced]).mean())


MIN_LOWBAND_GAP = 0.15
MIN_CLUSTER_SECONDS = 0.5
TURN_PAUSE = 0.5


def split_turns(rows: list[dict]) -> list[dict]:
    """Parte cada segmento de Whisper en tramos por las pausas y los finales de frase.

    Un segmento de Whisper puede juntar a los dos interlocutores («Hola. — Hola, buenas»): el cambio de
    voz casi siempre cae en una pausa o al final de una frase.
    """
    chunks = []
    for row in rows:
        words = row.get("words") or []
        if not words:
            chunks.append({k: row[k] for k in ("start", "end", "text")})
            continue
        current = [words[0]]
        for prev, word in zip(words, words[1:]):
            if word["start"] - prev["end"] >= TURN_PAUSE or prev["word"].rstrip().endswith((".", "?", "!")):
                chunks.append(_chunk(current))
                current = []
            current.append(word)
        chunks.append(_chunk(current))
    return [c for c in chunks if c["text"]]


def _chunk(words: list[dict]) -> dict:
    return {"start": round(words[0]["start"], 2), "end": round(words[-1]["end"], 2),
            "text": fix_company("".join(w["word"] for w in words).strip())}


def label_speakers(audio: np.ndarray, rows: list[dict]) -> list[dict] | None:
    """Turnos «agente» / «cliente» de una grabación mono (dos voces), o None si no se distinguen.

    Los tramos se reparten en dos grupos por su energía grave (corte que mejor separa los valores). Si los
    grupos difieren menos de MIN_LOWBAND_GAP no son dos voces distintas y no se etiqueta. Es GRUPO LYN el
    grupo que dice las frases de AGENT_CUES; sin pistas en el texto, el de más energía grave (VoIP).
    """
    chunks = split_turns(rows)
    for c in chunks:
        piece = audio[int(c["start"] * SAMPLE_RATE):int(c["end"] * SAMPLE_RATE)]
        c["low"] = lowband_ratio(piece) if len(piece) >= MIN_CLUSTER_SECONDS * SAMPLE_RATE else None
    values = sorted(c["low"] for c in chunks if c["low"] is not None)
    if len(values) < 2:
        return None
    # Corte de Otsu en una dimensión: el que maximiza la separación entre los dos grupos.
    best, cut = -1.0, None
    for k in range(1, len(values)):
        a, b = np.mean(values[:k]), np.mean(values[k:])
        score = k * (len(values) - k) * (b - a) ** 2
        if score > best:
            best, cut, means = score, (values[k - 1] + values[k]) / 2, (a, b)
    if means[1] - means[0] < MIN_LOWBAND_GAP:
        return None
    # Tramos demasiado cortos para medirlos («Sí,»): suelen abrir la respuesta, así que toman la voz del tramo
    # siguiente si empieza en menos de 1 s; si no, la del anterior.
    for c in chunks:
        c["group"] = None if c["low"] is None else int(c["low"] > cut)
    for i in range(len(chunks) - 1, -1, -1):  # de atrás adelante: el tramo siguiente ya tiene voz
        c = chunks[i]
        if c["group"] is not None:
            continue
        following = chunks[i + 1] if i + 1 < len(chunks) else None
        previous = next((x["group"] for x in reversed(chunks[:i]) if x["group"] is not None), None)
        if following and (following["start"] - c["end"] < 1.0 or previous is None):
            c["group"] = following["group"]
        else:
            c["group"] = previous if previous is not None else 1
    cue = [sum(bool(AGENT_CUES.search(c["text"])) for c in chunks if c["group"] == k) for k in (0, 1)]
    agent = int(np.argmax(cue)) if cue[0] != cue[1] else 1
    turns: list[dict] = []
    for c in chunks:
        speaker = "agente" if c["group"] == agent else "cliente"
        if turns and turns[-1]["speaker"] == speaker:
            turns[-1]["end"] = c["end"]
            turns[-1]["text"] += " " + c["text"]
        else:
            turns.append({"start": c["start"], "end": c["end"], "text": c["text"], "speaker": speaker})
    return turns


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


HOTWORDS = set(_words(os.environ.get("WHISPER_HOTWORDS", "Grupo LYN")))


def is_hallucination(text: str) -> bool:
    clean = text.strip().lower().strip(" .,!¡?¿")
    if any(clean == h.strip(" .,!¡?¿") for h in HALLUCINATIONS):
        return True
    # Solo las palabras de `hotwords` («Grupo LYN»): Whisper las repite cuando no oye nada.
    words = _words(text)
    return bool(words) and all(w in HOTWORDS for w in words)


def frame_db(audio: np.ndarray, seconds: float = 0.1) -> np.ndarray:
    win = int(seconds * SAMPLE_RATE)
    frames = audio[: len(audio) // win * win].reshape(-1, win)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)


SPEECH_DBFS = -45.0      # voz telefónica: entre −30 y −10 dBFS; el silencio de línea, por debajo de −55


def has_speech(audio: np.ndarray, start: float = 0.0) -> bool:
    """Al menos medio segundo seguido por encima de SPEECH_DBFS después de `start`."""
    loud = frame_db(audio[int(start * SAMPLE_RATE):]) > SPEECH_DBFS
    run = 0
    for value in loud:
        run = run + 1 if value else 0
        if run >= 5:
            return True
    return False


def audio_duration(path: str) -> float | None:
    proc = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                          capture_output=True, text=True, check=False)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


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
    Se salta hasta el primer medio segundo seguido a nivel de conversación, con 0,3 s de margen, y nunca
    más que la locución del aviso (`max_skip`): un saludo en voz baja justo después del aviso no se pierde
    (QA 22/10/2026: se perdían unos 4 s de «Hola. Hola. Buenas»).
    """
    db = frame_db(audio)
    if len(db) < 10:
        return 0.0
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
        extra.update(hallucination_silence_threshold=2.0)
    segments, _info = model.transcribe(
        audio, language=os.environ.get("WHISPER_LANGUAGE", "es"), **extra,
        beam_size=int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        hotwords=os.environ.get("WHISPER_HOTWORDS", "Grupo LYN") or None,
        # Sin arrastrar el texto anterior y sin repetir n-gramas: evita los bucles en audio telefónico.
        condition_on_previous_text=False, no_repeat_ngram_size=3, repetition_penalty=1.2,
        # Marcas por palabra: para partir los segmentos por turnos en mono (no cambian el texto).
        word_timestamps=True,
        vad_filter=single_voice,
        vad_parameters={"threshold": 0.3, "min_silence_duration_ms": 800, "speech_pad_ms": 300} if single_voice else None,
    )
    duration = len(audio) / SAMPLE_RATE
    rows = []
    for s in segments:  # generador: transcribe a medida que se recorre
        piece = audio[int(s.start * SAMPLE_RATE):int(min(s.end, duration) * SAMPLE_RATE)]
        # Texto sobre un tramo sin voz: inventado (p. ej. un segmento de 30 s sobre 21 s de silencio).
        voiced = len(piece) > 0 and has_speech(piece)
        if voiced and not is_hallucination(s.text) and not is_aviso(s.text):
            words = [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])]
            rows.append({"start": round(s.start, 2), "end": round(min(s.end, duration), 2), "text": fix_company(s.text.strip()), "words": words})
        progress(s.end)
    return rows


def main() -> None:
    language = os.environ.get("WHISPER_LANGUAGE", "es")
    model = None
    path = sys.argv[1]
    speakers = [v.strip() for v in os.environ.get("WHISPER_CHANNEL_SPEAKERS", "").split(",") if v.strip()]
    stereo = channel_count(path) >= 2 and len(speakers) == 2
    channels = [(0, speakers[0]), (1, speakers[1])] if stereo else [(None, None)]
    skip = os.environ.get("WHISPER_SKIP_QUIET_LEADIN") == "1"
    aviso_file = os.environ.get("WHISPER_AVISO_FILE", "").strip()
    max_skip = (audio_duration(aviso_file) if aviso_file else None) or 20.0
    print("PROGRESS 1", file=sys.stderr, flush=True)
    rows, skipped, speech = [], 0.0, False
    for index, (channel, speaker) in enumerate(channels):
        audio = decode_16k(path, channel)
        channel_rows = []
        total = max(len(audio) / SAMPLE_RATE, 0.001)
        start = quiet_leadin(audio, max_skip=max_skip) if skip and not stereo else 0.0
        skipped = max(skipped, start)
        if not has_speech(audio, start):
            continue  # solo silencio o ruido de línea: nada que transcribir en este canal
        speech = True
        model = model or WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8")
        def progress(end: float, index=index, total=total) -> None:
            done = (index + min(1.0, end / total)) / len(channels)
            print(f"PROGRESS {min(99, int(done * 100))}", file=sys.stderr, flush=True)
        for row in transcribe(model, audio, start, single_voice=stereo, progress=progress):
            channel_rows.append({**row, "speaker": speaker})
        if not stereo and os.environ.get("WHISPER_DIARIZE", "1") != "0":
            channel_rows = label_speakers(audio, channel_rows) or channel_rows
        rows.extend({k: v for k, v in r.items() if k != "words"} for r in channel_rows)
    rows.sort(key=lambda r: r["start"])
    names = {"agente": "Grupo LYN", "cliente": "Cliente"}
    labelled = any(r.get("speaker") for r in rows)
    text = "\n".join(f"{names.get(r.get('speaker'), 'Desconocido')}: {r['text']}" for r in rows) if labelled else " ".join(r["text"] for r in rows)
    print(json.dumps({"language": language, "text": text.strip(), "segments": rows, "stereo": stereo,
                      "skipped_seconds": round(skipped, 1), "no_speech": not speech}, ensure_ascii=False))


if __name__ == "__main__":
    main()
