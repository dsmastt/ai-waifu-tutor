"""SQLite-backed conversation + learning-progress store.

Deliberately structured (not a raw chat dump): messages are kept for
conversation continuity, while progress is distilled into concept-level
statistics the tutor can use to adapt.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
    concept TEXT PRIMARY KEY,
    mastery REAL NOT NULL DEFAULT 0.0,
    exposures INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    wrong INTEGER NOT NULL DEFAULT 0,
    last_seen REAL NOT NULL DEFAULT 0.0
);
"""


class MemoryStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def _default_conversation(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM conversations ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row:
                return int(row[0])
            cur = self._conn.execute(
                "INSERT INTO conversations (title, created_at) VALUES (?, ?)",
                ("New lesson", time.time()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def append_message(self, role: str, content: str, conversation_id: int | None = None) -> int:
        cid = conversation_id or self._default_conversation()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (cid, role, content, time.time()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def history(self, conversation_id: int | None = None, limit: int = 24) -> list[dict]:
        cid = conversation_id or self._default_conversation()
        with self._lock:
            rows = self._conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ? "
                "ORDER BY id DESC LIMIT ?",
                (cid, limit),
            ).fetchall()
        return [{"role": r, "content": c} for r, c in reversed(rows)]

    def record_progress(
        self,
        concept: str,
        correct: bool,
        weight: float = 0.15,
    ) -> None:
        concept = concept.strip()[:120]
        if not concept:
            return
        with self._lock:
            row = self._conn.execute(
                "SELECT mastery, exposures, correct, wrong FROM progress WHERE concept = ?",
                (concept,),
            ).fetchone()
            if row is None:
                mastery, exposures, correct, wrong = 0.0, 0, 0, 0
            else:
                mastery, exposures, correct, wrong = row
            exposures += 1
            correct += 1 if correct else 0
            wrong += 0 if correct else 1
            delta = weight if correct else -weight * 1.5
            mastery = max(0.0, min(1.0, mastery + delta))
            self._conn.execute(
                "INSERT INTO progress (concept, mastery, exposures, correct, wrong, last_seen) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(concept) DO UPDATE SET mastery=excluded.mastery, "
                "exposures=excluded.exposures, correct=excluded.correct, "
                "wrong=excluded.wrong, last_seen=excluded.last_seen",
                (concept, mastery, exposures, correct, wrong, time.time()),
            )
            self._conn.commit()

    def progress_summary(self) -> str:
        with self._lock:
            rows = self._conn.execute(
                "SELECT concept, mastery, exposures, correct, wrong FROM progress "
                "ORDER BY mastery ASC LIMIT 20"
            ).fetchall()
        if not rows:
            return ""
        lines = []
        for concept, mastery, exposures, correct, wrong in rows:
            if exposures == 0:
                continue
            lines.append(
                f"- {concept}: mastery {mastery:.0%} "
                f"({correct}/{exposures} correct, {wrong} wrong)"
            )
        return "\n".join(lines)
