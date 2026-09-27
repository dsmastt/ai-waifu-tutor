"""Configuration loaded from environment / .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"


def _load_env() -> None:
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    else:
        load_dotenv()


@dataclass
class Settings:
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"
    llm_api_key: str = ""
    llm_temperature: float = 0.8
    tts_voice: str = "af_bella"
    tts_speed: float = 1.0
    host: str = "127.0.0.1"
    port: int = 8000
    data_dir: Path = REPO_ROOT / "server" / "data"
    cache_dir: Path = REPO_ROOT / "server" / "cache"
    allowed_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    @property
    def provider(self) -> str:
        return "openai_compat" if self.llm_api_key else "mock"

    @property
    def kokoro_model_path(self) -> Path:
        return self.cache_dir / "kokoro" / "kokoro-v1.0.onnx"

    @property
    def kokoro_voices_path(self) -> Path:
        return self.cache_dir / "kokoro" / "voices-v1.0.bin"


def load_settings() -> Settings:
    _load_env()

    def f(name: str, default: str) -> str:
        return os.environ.get(name, default).strip() or default

    data_dir = Path(f("DATA_DIR", str(REPO_ROOT / "server" / "data"))).resolve()
    cache_dir = Path(f("CACHE_DIR", str(REPO_ROOT / "server" / "cache"))).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        llm_base_url=f("LLM_BASE_URL", "https://api.deepseek.com"),
        llm_model=f("LLM_MODEL", "deepseek-chat"),
        llm_api_key=f("LLM_API_KEY", ""),
        llm_temperature=float(f("LLM_TEMPERATURE", "0.8")),
        tts_voice=f("TTS_VOICE", "af_bella"),
        tts_speed=float(f("TTS_SPEED", "1.0")),
        host=f("HOST", "127.0.0.1"),
        port=int(f("PORT", "8000")),
        data_dir=data_dir,
        cache_dir=cache_dir,
    )


settings = load_settings()
