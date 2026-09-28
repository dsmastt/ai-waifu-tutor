"""Turn orchestration: LLM events -> validated actions + sentence-wise TTS.

Pipeline per turn:
  producer task: LLM stream -> validated events -> queue
  consumer:      speech events -> sentence buffer -> TTS (threadpool) -> audio
                 action events  -> forwarded immediately
Interruption cancels the producer, drains nothing, and notifies the client.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import AsyncIterator

from ..config import Settings
from ..llm.base import TutorProvider
from ..memory import MemoryStore, SyllabusStore
from ..protocol import ActionEvent, LLMEvent, SpeechEvent
from ..tts import TTSEngine
from .prompt import build_system_prompt
from .settings_schema import TutorSettings, default_tutor_settings

log = logging.getLogger(__name__)

_SENTENCE_END = re.compile(r"[.!?…]+(\s|$)")
_MAX_SENTENCE = 240

class TutorBrain:
    def __init__(
        self,
        settings: Settings,
        provider: TutorProvider,
        tts: TTSEngine,
        memory: MemoryStore,
        syllabus: SyllabusStore,
    ):
        self._settings = settings
        self._provider = provider
        self._tts = tts
        self._memory = memory
        self._syllabus = syllabus
        self._tutor_settings = default_tutor_settings()
        self._interrupt = asyncio.Event()
        self._active: asyncio.Task | None = None
        self._pending_question: dict | None = None
        self._id_counter = 0

    # -- public API ---------------------------------------------------------

    @property
    def tutor_settings(self) -> TutorSettings:
        return self._tutor_settings

    def update_tutor_settings(self, data: dict) -> None:
        try:
            self._tutor_settings = TutorSettings.model_validate(
                data.get("tutor", data)
            )
        except Exception:
            log.warning("Ignoring invalid tutor settings: %r", data)

    def interrupt(self) -> None:
        self._interrupt.set()
        if self._active is not None and not self._active.done():
            self._active.cancel()

    async def run_turn(self, user_text: str) -> AsyncIterator[dict]:
        """Handle a plain user message."""
        self._memory.append_message("user", user_text)
        async for event in self._stream_turn(
            yield_speech=True,
            extra_system=None,
            user_label=user_text,
        ):
            yield event

    async def run_answer_turn(
        self, question_id: str, answer_text: str
    ) -> AsyncIterator[dict]:
        """Handle a student answer: evaluate it, then continue the lesson."""
        verdict = self._evaluate_answer(question_id, answer_text)
        verdict_note = ""
        if verdict is True:
            verdict_note = "The submitted answer is CORRECT."
        elif verdict is False:
            verdict_note = "The submitted answer is INCORRECT."
        self._memory.append_message("user", f"My answer: {answer_text}")
        yield {"t": "verdict", "ok": verdict}
        context = (
            f"The student submitted this answer to question id '{question_id}': "
            f'"{answer_text}".\n'
            f"{verdict_note}\n"
            "Evaluate it: acknowledge what is right, correct what is wrong, "
            "explain briefly, then continue the lesson. If they were right, "
            "praise them genuinely and move to the next idea."
        )
        async for event in self._stream_turn(
            yield_speech=True,
            extra_system=context,
            user_label=f"My answer to your question: {answer_text}",
        ):
            yield event

    def _evaluate_answer(self, question_id: str, answer: str) -> bool | None:
        """Deterministic check when the question carried a correct answer."""
        q = self._pending_question
        if not q:
            log.warning("no pending question for answer %r", answer)
            return None
        qid = q.get("id")
        if qid and qid != question_id:
            log.warning(
                "answer question_id %r != pending %r", question_id, qid
            )
            return None
        self._pending_question = None
        correct = q.get("correct")
        concept = q.get("concept") or "general"
        if correct is None:
            return None
        ok = _answer_matches(answer, correct, q.get("answer_type"))
        log.info("answer %r vs %r -> %s", answer, correct, ok)
        self._memory.record_progress(concept, ok)
        return ok

    # -- internals ----------------------------------------------------------

    async def _stream_turn(
        self,
        yield_speech: bool,
        extra_system: str | None,
        user_label: str | None = None,
    ) -> AsyncIterator[dict]:
        self._interrupt.clear()
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)

        system = build_system_prompt(
            self._tutor_settings,
            progress_summary=self._memory.progress_summary(),
            syllabus_snippets=await self._syllabus.search(user_label or "", limit=4),
        )
        messages: list[dict] = [{"role": "system", "content": system}]
        messages += self._memory.history(limit=24)
        if extra_system:
            messages.append({"role": "system", "content": extra_system})

        async def produce() -> None:
            try:
                log.info("produce: starting provider stream")
                async for event in self._provider.stream_turn(
                    messages, self._settings.llm_temperature
                ):
                    if self._interrupt.is_set():
                        log.info("produce: interrupt flag set, stopping")
                        return
                    await queue.put(event)
            except asyncio.CancelledError:
                log.info("produce: cancelled")
                return
            except Exception as exc:
                log.exception("LLM stream failed")
                await queue.put(exc)
            finally:
                log.info("produce: ending")
                await queue.put(None)

        producer = asyncio.create_task(produce())
        self._active = asyncio.current_task()

        yield {"t": "status", "state": "thinking"}

        buffer = ""
        spoken_full = ""
        action_log: list[str] = []
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    yield {"t": "error", "message": str(item)}
                    break
                if self._interrupt.is_set():
                    break

                if isinstance(item, SpeechEvent):
                    if yield_speech:
                        yield {"t": "speech_delta", "text": item.text}
                    buffer += item.text

                    while True:
                        m = _SENTENCE_END.search(buffer)
                        cut = None
                        if m:
                            cut = m.end()
                        elif len(buffer) > _MAX_SENTENCE:
                            cut = _hard_cut(buffer)
                        if cut is None:
                            break
                        sentence = buffer[:cut].strip()
                        buffer = buffer[cut:].lstrip()
                        if sentence:
                            spoken_full += sentence + " "
                            async for out in self._speak(sentence):
                                yield out
                        if self._interrupt.is_set():
                            break

                elif isinstance(item, ActionEvent):
                    action = item.a
                    self._ensure_action_id(action)
                    self._register_question(action)
                    self._log_action(action, action_log)
                    yield {"t": "action", "a": action.model_dump()}

            # flush remainder
            tail = buffer.strip()
            if tail and not self._interrupt.is_set():
                spoken_full += tail
                async for out in self._speak(tail):
                    yield out

            if self._interrupt.is_set():
                yield {"t": "interrupted"}
            else:
                if spoken_full.strip():
                    self._memory.append_message("assistant", spoken_full.strip())
                if action_log:
                    self._memory.append_message(
                        "assistant",
                        "[Scene state you now have: " + "; ".join(action_log) + "]",
                    )
                yield {"t": "turn_end"}
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            self._active = None

    def _ensure_action_id(self, action) -> None:
        """Assign stable ids to window-creating actions when the LLM omits
        them, so both sides (and the model's scene-state notes) agree."""
        from ..protocol import AskQuestionAction, CreateWindowAction

        if isinstance(action, (CreateWindowAction, AskQuestionAction)) and not action.id:
            self._id_counter += 1
            action.id = f"w{self._id_counter}"

    @staticmethod
    def _log_action(action, log: list[str]) -> None:
        """Compact scene-state note so the LLM can reference its own windows."""
        from ..protocol import CreateWindowAction

        if isinstance(action, CreateWindowAction) and action.id:
            w = action.win
            title = w.title or w.kind
            log.append(f"window {action.id} ({w.kind} '{title}')")
        elif action.type == "close_window":
            log.append(f"closed window {action.id}")

    def _register_question(self, action) -> None:
        """Track the latest question the tutor asked, for answer evaluation."""
        from ..protocol import AskQuestionAction, CreateWindowAction

        if isinstance(action, AskQuestionAction):
            self._pending_question = {
                "id": action.id,
                "prompt": action.prompt,
                "answer_type": action.answer_type,
                "correct": action.correct,
                "concept": action.concept,
            }
        elif isinstance(action, CreateWindowAction) and action.win.kind == "question":
            q = action.win.question or {}
            self._pending_question = {
                "id": action.id,
                "prompt": q.get("prompt"),
                "answer_type": q.get("answer_type", "text"),
                "correct": q.get("correct"),
                "concept": q.get("concept"),
            }

    async def _speak(self, sentence: str) -> AsyncIterator[dict]:
        if not self._tts.available:
            return
        try:
            wav, visemes = await asyncio.to_thread(
                self._tts.synthesize, sentence
            )
        except Exception:
            log.exception("TTS failed for sentence %r", sentence[:60])
            return
        b64 = base64.b64encode(wav).decode("ascii")
        chunk = 24_000  # ~0.25s of b64 audio per message
        for i in range(0, len(b64), chunk):
            yield {"t": "audio", "format": "wav", "chunk": b64[i : i + chunk]}
        if visemes:
            yield {"t": "visemes", "events": visemes}
        yield {"t": "utterance_end"}

def _hard_cut(text: str) -> int:
    for i in range(len(text) - 1, 0, -1):
        if text[i] in " ,;:—-":
            return i + 1
    return len(text)

def _normalize_answer(text: str) -> str:
    return " ".join(text.strip().lower().split())

def _answer_matches(answer: str, correct: str, answer_type: str) -> bool:
    a = _normalize_answer(answer)
    c = _normalize_answer(correct)
    if not a or not c:
        return False
    if a == c:
        return True
    if answer_type == "numeric":
        try:
            return abs(float(a) - float(c)) < 1e-6 * max(1.0, abs(float(c)))
        except ValueError:
            return False
    return a in c or c in a
