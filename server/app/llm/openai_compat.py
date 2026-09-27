"""OpenAI-compatible streaming provider (DeepSeek by default).

The model is instructed to emit newline-delimited JSON events. We accumulate
text deltas and split on newlines; each complete line is validated against
the protocol models. Invalid lines are dropped silently.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from openai import AsyncOpenAI

from ..config import Settings
from ..protocol import LLMEvent
from .base import TutorProvider, LLMError


class OpenAICompatProvider(TutorProvider):
    name = "openai_compat"

    def __init__(self, settings: Settings):
        self._client = AsyncOpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
        )
        self._model = settings.llm_model
        self._lock = asyncio.Lock()

    def _parse_line_robust(self, line: str):
        """Parse one model line: strict NDJSON first, then JSON extraction,
        then a prose fallback (treated as plain speech)."""
        line = line.strip()
        if not line:
            return None
        event = self._parse_line(line)
        if event is not None:
            return event

        # strip markdown fences
        if line.startswith("```"):
            line = line.strip("`")
        start = line.find("{")
        end = line.rfind("}")
        if start >= 0 and end > start:
            event = self._parse_line(line[start : end + 1])
            if event is not None:
                return event

        # prose fallback: model ignored the protocol; speak the text verbatim
        from ..protocol import SpeechEvent

        return SpeechEvent(t="speech", text=line)

    async def stream_turn(
        self, messages: list[dict], temperature: float
    ) -> AsyncIterator[LLMEvent]:
        async with self._lock:
            try:
                stream = await self._client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    temperature=temperature,
                    stream=True,
                )
            except Exception as exc:  # network/auth/provider errors
                raise LLMError(f"LLM request failed: {exc}") from exc

            buffer = ""
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if not delta or not delta.content:
                    continue
                buffer += delta.content
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    event = self._parse_line_robust(line)
                    if event is not None:
                        yield event
            # flush any trailing partial line (usually whitespace only)
            event = self._parse_line_robust(buffer)
            if event is not None:
                yield event
