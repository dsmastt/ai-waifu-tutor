"""The validated event contract between the LLM/tutor brain and the app.

The LLM emits newline-delimited JSON lines. Every line is parsed and validated
against these models. Anything that does not validate is dropped. Nothing from
the LLM is ever executed as code.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

# ---------------------------------------------------------------------------
# Window specifications (AI -> app)
# ---------------------------------------------------------------------------

WindowKind = Literal[
    "text", "markdown", "equation", "graph", "question", "image",
    "table", "code", "whiteboard",
]


class WindowSpec(BaseModel):
    """Payload for create_window. Exactly one kind-specific field is used."""

    kind: WindowKind
    title: str | None = Field(default=None, max_length=120)
    content: str | None = Field(default=None, max_length=200_000)
    equation: str | None = Field(default=None, max_length=4_000)
    graph: dict | None = None
    question: dict | None = None
    image_url: str | None = Field(default=None, max_length=2_000)
    rows: list[list[str]] | None = None
    position: Literal["left", "right", "center", "auto"] = "auto"


# ---------------------------------------------------------------------------
# Actions (AI -> app)
# ---------------------------------------------------------------------------

GestureName = Literal["point", "nod", "shake", "wave", "think", "shrug", "clap"]
ExpressionName = Literal[
    "neutral", "happy", "sad", "surprised", "thinking", "angry", "relaxed",
]


class CreateWindowAction(BaseModel):
    type: Literal["create_window"]
    win: WindowSpec
    id: str | None = Field(default=None, max_length=64)


class CloseWindowAction(BaseModel):
    type: Literal["close_window"]
    id: str = Field(max_length=64)


class LookAtAction(BaseModel):
    type: Literal["look_at"]
    target: Literal["me", "board", "random", "none"] | str = Field(max_length=64)


class GestureAction(BaseModel):
    type: Literal["gesture"]
    name: GestureName
    target: str | None = Field(default=None, max_length=64)


class ExpressionAction(BaseModel):
    type: Literal["expression"]
    name: ExpressionName
    intensity: float = Field(default=1.0, ge=0.0, le=1.0)


class FocusWindowAction(BaseModel):
    type: Literal["focus_window"]
    id: str = Field(max_length=64)


class AskQuestionAction(BaseModel):
    type: Literal["ask_question"]
    id: str | None = Field(default=None, max_length=64)
    prompt: str = Field(max_length=2_000)
    answer_type: Literal["text", "choice", "numeric"] = "text"
    options: list[str] | None = Field(default=None, max_length=8)
    correct: str | None = Field(default=None, max_length=500)
    concept: str | None = Field(default=None, max_length=120)


Action = Annotated[
    Union[
        CreateWindowAction,
        CloseWindowAction,
        LookAtAction,
        GestureAction,
        ExpressionAction,
        FocusWindowAction,
        AskQuestionAction,
    ],
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# LLM event lines
# ---------------------------------------------------------------------------

class SpeechEvent(BaseModel):
    t: Literal["speech"]
    text: str = Field(max_length=8_000)


class ActionEvent(BaseModel):
    t: Literal["action"]
    a: Action

    @model_validator(mode="before")
    @classmethod
    def _accept_flattened(cls, data):
        """Tolerate models that drop the 'a' wrapper:
        {"t":"action","type":"look_at",...} -> {"t":"action","a":{"type":...}}"""
        if (
            isinstance(data, dict)
            and data.get("t") == "action"
            and "a" not in data
        ):
            return {"t": "action", "a": {k: v for k, v in data.items() if k != "t"}}
        return data


LLMEvent = Annotated[Union[SpeechEvent, ActionEvent], Field(discriminator="t")]


# ---------------------------------------------------------------------------
# Client -> server messages
# ---------------------------------------------------------------------------

class UserMessage(BaseModel):
    t: Literal["user_message"]
    text: str = Field(min_length=1, max_length=8_000)


class AnswerMessage(BaseModel):
    t: Literal["answer"]
    question_id: str = Field(max_length=64)
    text: str = Field(max_length=2_000)


class InterruptMessage(BaseModel):
    t: Literal["interrupt"]


class SettingsUpdateMessage(BaseModel):
    t: Literal["settings_update"]
    settings: dict


ClientMessage = Annotated[
    Union[UserMessage, AnswerMessage, InterruptMessage, SettingsUpdateMessage],
    Field(discriminator="t"),
]


# Type adapters: the Annotated unions above are typing aliases, so use these
# to validate incoming data.
LLMEventAdapter = TypeAdapter(LLMEvent)
ClientMessageAdapter = TypeAdapter(ClientMessage)
