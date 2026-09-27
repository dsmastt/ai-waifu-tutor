"""Tutor customization settings (runtime-editable, persisted per user)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TutorSettings(BaseModel):
    name: str = Field(default="Aoi", max_length=40)
    personality: str = Field(
        default="warm, patient, and a little playful",
        max_length=400,
    )
    teaching_style: str = Field(
        default="socratic, example-driven",
        max_length=400,
    )
    depth: str = Field(default="moderate", max_length=40)
    difficulty: str = Field(default="adaptive", max_length=40)
    question_frequency: str = Field(default="often", max_length=40)
    response_length: str = Field(default="medium", max_length=40)
    custom_instructions: str = Field(default="", max_length=2000)


def default_tutor_settings() -> TutorSettings:
    return TutorSettings()
