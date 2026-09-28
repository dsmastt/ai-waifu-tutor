"""Configuration loaded from environment / .env file."""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

log = logging.getLogger("config")

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env"
ENV_EXAMPLE_PATH = REPO_ROOT / ".env.example"


def _load_env() -> None:
    # convenience: bootstrap a real .env from the template on first run so a
    # key added to .env.example actually takes effect
    if not ENV_PATH.exists() and ENV_EXAMPLE_PATH.exists():
        shutil.copy(ENV_EXAMPLE_PATH, ENV_PATH)
        log.info("No .env found - created it from .env.example")
    load_dotenv(ENV_PATH)


@dataclass
class Settings:
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"
    llm_api_key: str = ""
    llm_temperature: float = 0.8
    llm_json_mode: bool = True
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

    def resolve(path_value: str, default: Path) -> Path:
        path = Path(path_value)
        if not path.is_absolute():
            path = REPO_ROOT / path
        return path.resolve()

    data_dir = resolve(f("DATA_DIR", "server/data"), REPO_ROOT / "server" / "data")
    cache_dir = resolve(f("CACHE_DIR", "server/cache"), REPO_ROOT / "server" / "cache")
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        llm_base_url=f("LLM_BASE_URL", "https://api.deepseek.com"),
        llm_model=f("LLM_MODEL", "deepseek-chat"),
        llm_api_key=f("LLM_API_KEY", ""),
        llm_temperature=float(f("LLM_TEMPERATURE", "0.8")),
        llm_json_mode=f("LLM_JSON_MODE", "1").lower() not in ("0", "false", "no"),
        tts_voice=f("TTS_VOICE", "af_bella"),
        tts_speed=float(f("TTS_SPEED", "1.0")),
        host=f("HOST", "127.0.0.1"),
        port=int(f("PORT", "8000")),
        data_dir=data_dir,
        cache_dir=cache_dir,
    )


settings = load_settings()
