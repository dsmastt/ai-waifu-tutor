from __future__ import annotations

from ..config import Settings
from .base import TutorProvider
from .mock import MockProvider
from .openai_compat import OpenAICompatProvider


def get_provider(settings: Settings) -> TutorProvider:
    if settings.provider == "mock":
        return MockProvider()
    return OpenAICompatProvider(settings)
