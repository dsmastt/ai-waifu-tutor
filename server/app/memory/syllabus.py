"""Syllabus retrieval.

Milestone stub: the store is fully wired for later retrieval of uploaded
material (chunking + embedding). For now it holds no documents and returns
nothing, keeping the rest of the pipeline honest.
"""

from __future__ import annotations

from typing import Protocol


class SyllabusStore(Protocol):
    async def search(self, query: str, limit: int = 4) -> list[str]: ...


class EmptySyllabusStore:
    async def search(self, query: str, limit: int = 4) -> list[str]:
        return []


def get_syllabus_store() -> SyllabusStore:
    return EmptySyllabusStore()
