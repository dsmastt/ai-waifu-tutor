"""OpenAI-compatible streaming provider (DeepSeek by default).

The model is asked for a single JSON object {"events":[...]} of validated
tutor events, using strict JSON output mode when the provider supports it.
Parsing is defensive and layered:

  1. incremental parsing of the root JSON object (streams events as soon as
     each array element is complete),
  2. newline-delimited JSON lines (models that ignore JSON mode),
  3. whole-buffer JSON extraction at end of stream,
  4. prose fallback: if nothing valid ever parsed, speak the text verbatim.

Invalid events are dropped; nothing is ever executed.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from openai import AsyncOpenAI

from ..config import Settings
from ..protocol import LLMEvent, LLMEventAdapter, SpeechEvent
from .base import TutorProvider, LLMError

log = logging.getLogger(__name__)


class _ScanError(Exception):
    pass


def _find_complete_json(text: str, start: int) -> tuple[dict, int] | None:
    """Return (parsed dict, end index) of the JSON value starting at `start`,
    or None if it is not complete yet / invalid."""
    i = start
    n = len(text)
    if i >= n or text[i] != "{":
        return None
    depth = 0
    in_str = False
    escape = False
    while i < n:
        c = text[i]
        if in_str:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        return None
                    if not isinstance(value, dict):
                        return None
                    return value, i + 1
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
        i += 1
    return None


class _EventsStreamParser:
    """Incrementally extracts validated events from a streaming JSON body."""

    def __init__(self):
        self.buffer = ""
        self.raw = ""
        self.in_root = False
        self.yielded = 0

    def feed(self, chunk: str):
        """Feed new text; yields (event, already_validated=True) dicts."""
        self.buffer += chunk
        self.raw += chunk
        # repair a common model slip: {"t":"action":{"type":...}} loses the
        # comma after "action" -> {"t":"action","type":...}
        self.buffer = self.buffer.replace('"action":{', '"action",')
        out: list[dict] = []
        for ev in self._extract_ndjson_lines():
            out.append(ev)
        for ev in self._extract_root_events():
            out.append(ev)
        return out

    def _extract_ndjson_lines(self):
        if self.in_root:
            return []
        out = []
        while "\n" in self.buffer:
            line, rest = self.buffer.split("\n", 1)
            self.buffer = rest
            line = line.strip()
            if not line or line.startswith("```"):
                continue
            data = _try_json(line)
            if data is None:
                # not JSON yet: maybe a partial line, keep it for later
                self.buffer = line + "\n" + self.buffer
                break
            ev = _validate_event(data)
            if ev is not None:
                out.append(ev)
        return out

    def _extract_root_events(self):
        out = []
        for _ in range(100):
            # find the root object start
            idx = self.buffer.find("{")
            if idx < 0:
                break
            complete = _find_complete_json(self.buffer, idx)
            if complete is None:
                # root may be malformed (e.g. model dropped a key): recover
                # individual events by scanning each '{' position
                while True:
                    before = len(out)
                    out += self._scan_fragments()
                    if len(out) == before:
                        break
                break
            value, end = complete
            self.buffer = self.buffer[end:]
            if not self.in_root and "events" not in value and "t" not in value:
                # a nested object we don't understand: skip it
                continue
            if "events" in value and isinstance(value["events"], list):
                self.in_root = True
                for item in value["events"]:
                    ev = _validate_event(item) if isinstance(item, dict) else None
                    if ev is not None:
                        out.append(ev)
            else:
                ev = _validate_event(value)
                if ev is not None:
                    out.append(ev)
        return out

    def _scan_fragments(self):
        """Recover one brace-balanced event object from a malformed body."""
        text = self.buffer
        i = 0
        while i < len(text):
            i = text.find("{", i)
            if i < 0:
                break
            found = _find_complete_json(text, i)
            if found is not None:
                value, end = found
                i = end
                if isinstance(value, dict) and "t" in value:
                    ev = _validate_event(value)
                    if ev is not None:
                        self.buffer = text[end:]
                        return [ev]
                continue
            i += 1
        return []

    def flush(self):
        """End of stream: try the remaining buffer, then fall back to prose."""
        out: list[dict] = []
        text = self.buffer
        self.buffer = ""
        if text.strip():
            data = _try_json(text)
            if isinstance(data, dict) and isinstance(data.get("events"), list):
                for item in data["events"]:
                    ev = _validate_event(item) if isinstance(item, dict) else None
                    if ev is not None:
                        out.append(ev)
            else:
                ev = _validate_event(data) if isinstance(data, dict) else None
                if ev is not None:
                    out.append(ev)
        if not out and self.yielded == 0:
            # nothing at all parsed from this response: if the whole answer
            # is plain prose, speak it verbatim (never execute)
            from ..protocol import SpeechEvent

            t = self.raw.strip()
            if t and not t.startswith("{") and not t.startswith("["):
                out.append(SpeechEvent(t="speech", text=t[:2000]).model_dump())
        return out


def _try_json(text: str):
    t = text.strip().strip("`")
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return None


def _validate_event(data: dict):
    try:
        event = LLMEventAdapter.validate_python(data)
    except Exception:
        return None
    return event.model_dump()


_CORRECTIVE_NOTE = (
    "Your previous response could not be parsed. You MUST output exactly one "
    'JSON object: {"events":[{"t":"speech","text":"..."},{"t":"action",'
    '"type":"...",...}]} — valid JSON only, nothing else. Do not explain, '
    "just output the JSON."
)


class OpenAICompatProvider(TutorProvider):
    name = "openai_compat"

    def __init__(self, settings: Settings):
        self._client = AsyncOpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
        )
        self._model = settings.llm_model
        self._json_mode = settings.llm_json_mode
        self._lock = asyncio.Lock()

    async def stream_turn(
        self, messages: list[dict], temperature: float
    ) -> AsyncIterator[LLMEvent]:
        async with self._lock:
            for attempt in range(2):
                log.info("provider: lock acquired, requesting stream (attempt %d)", attempt + 1)
                stream = await self._open_stream(messages, temperature)
                parser = _EventsStreamParser()
                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if not delta or not delta.content:
                        continue
                    for ev in parser.feed(delta.content):
                        parser.yielded += 1
                        yield _to_event(ev)
                for ev in parser.flush():
                    parser.yielded += 1
                    yield _to_event(ev)
                if parser.yielded > 0:
                    log.info("provider: stream complete, %d events", parser.yielded)
                    return
                # the response produced no usable events: log it and retry
                # once with a corrective instruction
                log.warning(
                    "provider: no valid events parsed (raw=%r)",
                    parser.raw[:200],
                )
                if attempt == 0:
                    messages = messages + [{"role": "system", "content": _CORRECTIVE_NOTE}]
                    await asyncio.sleep(0.6)

            # both attempts produced nothing usable: never go fully silent
            log.warning("provider: giving up after 2 unparseable responses")
            yield SpeechEvent(
                t="speech",
                text=(
                    "Sorry, I lost my train of thought there. "
                    "Could you say that again?"
                ),
            )

    async def _open_stream(self, messages: list[dict], temperature: float):
        kwargs: dict = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
        }
        if self._json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            return await self._client.chat.completions.create(**kwargs)
        except Exception as exc:
            if not self._json_mode:
                raise LLMError(f"LLM request failed: {exc}") from exc
            # provider may not support JSON mode: retry once without it
            kwargs.pop("response_format", None)
            try:
                return await self._client.chat.completions.create(**kwargs)
            except Exception as exc2:
                raise LLMError(f"LLM request failed: {exc2}") from exc2


def _to_event(data: dict) -> LLMEvent:
    return LLMEventAdapter.validate_python(data)
