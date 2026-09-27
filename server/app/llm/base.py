from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import AsyncIterator

from ..protocol import LLMEvent, LLMEventAdapter


class LLMError(RuntimeError):
    pass


class TutorProvider(ABC):
    """Streams validated tutor events (speech + actions) from an LLM."""

    name: str = "base"

    @abstractmethod
    async def stream_turn(
        self, messages: list[dict], temperature: float
    ) -> AsyncIterator[LLMEvent]:
        """Yield parsed, schema-validated events for one tutor turn."""
        raise NotImplementedError

    def _parse_line(self, line: str) -> LLMEvent | None:
        line = line.strip()
        if not line or line.startswith("```"):
            return None
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return None
        try:
            return LLMEventAdapter.validate_python(data)
        except Exception:
            return None
