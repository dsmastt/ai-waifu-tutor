"""Deterministic offline provider used when no API key is configured.

Lets the whole pipeline (LLM -> events -> TTS -> windows) be exercised without
network access or credentials.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from ..protocol import (
    ActionEvent,
    ExpressionAction,
    GestureAction,
    LLMEvent,
    LookAtAction,
    SpeechEvent,
    WindowSpec,
)
from .base import TutorProvider


class MockProvider(TutorProvider):
    name = "mock"

    async def stream_turn(
        self, messages: list[dict], temperature: float
    ) -> AsyncIterator[LLMEvent]:
        user_text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                user_text = m.get("content", "")
                break

        topic = user_text.strip()[:80] or "your question"
        script: list[LLMEvent] = [
            SpeechEvent(
                t="speech",
                text=(
                    f"Hi! I'm your tutor. You asked about: {topic}. "
                    "I'm running in mock mode because no API key is configured, "
                    "so let me show you what I can do."
                ),
            ),
            ActionEvent(
                t="action",
                a={
                    "type": "expression",
                    "name": "happy",
                    "intensity": 1.0,
                },
            ),
            ActionEvent(
                t="action",
                a={
                    "type": "create_window",
                    "win": WindowSpec(
                        kind="markdown",
                        title="Your request",
                        content=(
                            f"### You asked\n\n> {topic}\n\n"
                            "**Mock mode** means the LLM is replaced by this canned "
                            "script. Add `LLM_API_KEY` to `.env` to switch to the "
                            "real model.\n\n"
                            "- I can create windows like this one\n"
                            "- I can point at them and look at you\n"
                            "- I can ask questions\n"
                        ),
                        position="left",
                    ),
                },
            ),
            ActionEvent(
                t="action",
                a={"type": "look_at", "target": "me"},
            ),
            SpeechEvent(
                t="speech",
                text=(
                    "Over there is a floating window I just created. "
                    "I can make equations, graphs, tables, and more."
                ),
            ),
            ActionEvent(
                t="action",
                a={
                    "type": "create_window",
                    "win": WindowSpec(
                        kind="equation",
                        title="Example equation",
                        equation=r"f(x) = x^2 \implies f'(x) = 2x",
                        position="right",
                    ),
                },
            ),
            ActionEvent(
                t="action",
                a={"type": "gesture", "name": "point"},
            ),
            SpeechEvent(
                t="speech",
                text="I can also plot functions for you, like this parabola!",
            ),
            ActionEvent(
                t="action",
                a={
                    "type": "create_window",
                    "win": WindowSpec(
                        kind="graph",
                        title="A parabola",
                        graph={
                            "functions": ["x^2", "2x"],
                            "x_range": [-3, 3],
                            "labels": {"x": "x", "y": "y", "title": "y = x² and its derivative"},
                            "annotations": [
                                {"x": 1, "y": 1, "text": "tangent slope = 2"}
                            ],
                        },
                        position="left",
                    ),
                },
            ),
            SpeechEvent(
                t="speech",
                text="Now, a quick check of understanding!",
            ),
            ActionEvent(
                t="action",
                a={
                    "type": "ask_question",
                    "id": "q1",
                    "prompt": "What is the derivative of x squared?",
                    "answer_type": "choice",
                    "options": ["2x", "x", "2x^2"],
                    "correct": "2x",
                    "concept": "derivatives of polynomials",
                },
            ),
            ActionEvent(
                t="action",
                a={"type": "expression", "name": "thinking", "intensity": 0.8},
            ),
        ]
        for event in script:
            yield event
            await asyncio.sleep(0.05)
