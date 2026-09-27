"""Local TTS via Kokoro (ONNX, CPU).

Kokoro is a small (~82M param) high-quality TTS model. It runs comfortably on
CPU and keeps GPU VRAM free for rendering. The model files live under
server/cache/kokoro (see scripts/fetch-assets.sh).

Lip sync: if the ONNX export reports per-phoneme durations we use them
verbatim; otherwise we G2P the text with the same phonemizer the model uses
and estimate durations per phoneme class, scaled to the real audio length and
offset by punctuation pauses. Phoneme order is exact in both cases.
"""

from __future__ import annotations

import io
import logging
import unicodedata
import wave

import numpy as np

from ..config import Settings

log = logging.getLogger(__name__)

VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore",
    "af_sarah", "af_sky", "am_adam", "am_michael", "am_onyx",
]

# espeak-style phoneme chars -> VRM viseme names (aa / ee / ih / oh / ou)
_VISEME_MAP: dict[str, str] = {}
for _v, _chars in {
    "aa": "aɑɒɔʌɐæ",
    "ee": "iɪeɛæ",
    "ih": "ɨɘəɵɚ",
    "oh": "oɔəʊ",
    "ou": "uʊw",
}.items():
    for _c in _chars:
        _VISEME_MAP[_c] = _v

_VOWELS = set("aeiouyɑɒɔəɛɜɐɪʊʌɨɘɵɚøœɯɤæʏʉ")
_NASALS = set("lmnŋɹrɾɻɳɲɴʎʁ")
_FRICS = set("sfvθðzʒʃhçɸχɣʂxβ")
_STOPS = set("pbtdkɡʔɖʈɟ")
_AFFR = set("ʧʤʣʥʦʨꭧ")
_GLIDES = set("wjɥʋɰ")

_BASE_SECONDS = {
    "vowel": 0.085,
    "nasal": 0.055,
    "fric": 0.075,
    "stop": 0.045,
    "affr": 0.060,
    "glide": 0.060,
}

_PAUSE_SECONDS = {
    "—": 0.35,
    "…": 0.30,
    ".": 0.26,
    "!": 0.26,
    "?": 0.26,
    ",": 0.12,
    ";": 0.12,
    ":": 0.12,
}
_IGNORED = set("ˈˌː↓→↗↘̃ᵝʸʰʲ")
_SKIP_CHARS = set('"“”() ')


def phoneme_to_viseme(phoneme: str) -> str:
    p = "".join(
        c for c in unicodedata.normalize("NFKD", phoneme) if not unicodedata.combining(c)
    ).lower()
    for char in p:
        if char in _VISEME_MAP:
            return _VISEME_MAP[char]
    return "ih"


def _phoneme_class(char: str) -> str:
    if char in _VOWELS:
        return "vowel"
    if char in _NASALS:
        return "nasal"
    if char in _FRICS:
        return "fric"
    if char in _STOPS:
        return "stop"
    if char in _AFFR:
        return "affr"
    if char in _GLIDES:
        return "glide"
    return "vowel"


def estimate_visemes(phoneme_string: str, audio_seconds: float) -> list[dict]:
    """Approximate per-phoneme timings for a phonemized sentence."""
    units: list[tuple[str, float, bool]] = []  # (viseme, seconds, is_pause)
    pause_total = 0.0
    for char in phoneme_string:
        if char in _SKIP_CHARS:
            continue
        if char in _IGNORED:
            if char == "ː" and units:
                units[-1] = (units[-1][0], units[-1][1] * 1.35, False)
            continue
        if char in _PAUSE_SECONDS:
            pause_total += _PAUSE_SECONDS[char]
            units.append((char, _PAUSE_SECONDS[char], True))
            continue
        viseme = _VISEME_MAP.get(char, "ih")
        units.append((viseme, _BASE_SECONDS[_phoneme_class(char)], False))

    spoken = sum(d for _, d, p in units if not p)
    target = max(0.0, audio_seconds - pause_total)
    if spoken <= 0 or target <= 0:
        return []
    scale = target / spoken

    events: list[dict] = []
    t = 0.0
    for viseme, dur, is_pause in units:
        d = dur if is_pause else dur * scale
        if not is_pause:
            events.append({"v": viseme, "start": t, "end": t + d})
        t += d
    return events


class TTSEngine:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._kokoro = None
        self._failed: Exception | None = None

    @property
    def voice(self) -> str:
        v = self._settings.tts_voice
        return v if v in VOICES else "af_bella"

    @property
    def available(self) -> bool:
        if self._failed is not None:
            return False
        try:
            self._load()
            return True
        except Exception as exc:  # pragma: no cover - environment dependent
            self._failed = exc
            log.warning("TTS unavailable: %s", exc)
            return False

    def _load(self) -> None:
        if self._kokoro is not None or self._failed is not None:
            return
        from kokoro_onnx import Kokoro  # heavy import, defer

        model = self._settings.kokoro_model_path
        voices = self._settings.kokoro_voices_path
        if model.exists() and voices.exists():
            self._kokoro = Kokoro(str(model), str(voices))
        else:
            raise FileNotFoundError(
                f"Kokoro model missing: {model} / {voices}. "
                "Run scripts/fetch-assets.sh"
            )

    def synthesize(self, text: str) -> tuple[bytes, list[dict]]:
        """Render text to (16-bit PCM mono WAV bytes @24kHz, viseme events)."""
        self._load()
        if self._kokoro is None:
            raise RuntimeError("TTS unavailable")
        kokoro = self._kokoro

        if kokoro.has_timings:
            samples, sample_rate, timings = kokoro.create_timed(
                text.strip(),
                voice=self.voice,
                speed=self._settings.tts_speed,
                lang="en-us",
            )
            visemes = [
                {"v": phoneme_to_viseme(t.phoneme), "start": t.start, "end": t.end}
                for t in timings
            ]
        else:
            samples, sample_rate = kokoro.create(
                text.strip(),
                voice=self.voice,
                speed=self._settings.tts_speed,
                lang="en-us",
            )
            phonemes = kokoro.tokenizer.phonemize(text.strip(), "en-us")
            visemes = estimate_visemes(
                phonemes, len(samples) / sample_rate
            )

        audio = np.asarray(samples, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.reshape(-1)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(int(sample_rate))
            wav.writeframes(pcm.tobytes())

        return buf.getvalue(), visemes
