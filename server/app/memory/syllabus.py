"""Syllabus storage and retrieval.

Uploaded material (PDFs, notes, text) is chunked and indexed with SQLite FTS5
for fast, deterministic keyword retrieval. The tutor brain pulls the top
snippets for the current query each turn. (Semantic embeddings are a
straightforward future swap: the interface is stable.)
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Protocol

_CHUNK_CHARS = 1000
_OVERLAP_CHARS = 120
_WORD_RE = re.compile(r"[a-zA-Z0-9'][a-zA-Z0-9']+")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    chunk_idx INTEGER NOT NULL,
    content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    doc_id UNINDEXED
);
"""


def _chunk_text(text: str) -> list[str]:
    text = re.sub(r"\r\n?", "\n", text)
    paragraphs = [p.strip() for p in text.split("\n")]
    paragraphs = [p for p in paragraphs if p]
    if not paragraphs:
        return []

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 1 <= _CHUNK_CHARS:
            current = (current + "\n" + para).strip()
        else:
            if current:
                chunks.append(current)
                current = current[-_OVERLAP_CHARS:] + "\n" + para
            else:
                # single huge paragraph: hard split
                while len(para) > _CHUNK_CHARS:
                    chunks.append(para[:_CHUNK_CHARS])
                    para = para[_CHUNK_CHARS - _OVERLAP_CHARS :]
                current = para
    if current:
        chunks.append(current)
    return chunks


class SyllabusStore(Protocol):
    async def search(self, query: str, limit: int = 4) -> list[str]: ...


class SQLiteSyllabusStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def add_document(self, filename: str, text: str) -> int:
        """Store a document as chunks. Returns the number of chunks."""
        chunks = _chunk_text(text)
        if not chunks:
            return 0
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO docs (filename, created_at) VALUES (?, ?)",
                (filename[:200], time.time()),
            )
            doc_id = int(cur.lastrowid)
            for i, chunk in enumerate(chunks):
                cur = self._conn.execute(
                    "INSERT INTO chunks (doc_id, chunk_idx, content) VALUES (?, ?, ?)",
                    (doc_id, i, chunk),
                )
                self._conn.execute(
                    "INSERT INTO chunks_fts (doc_id, content) VALUES (?, ?)",
                    (doc_id, chunk),
                )
            self._conn.commit()
        return len(chunks)

    def search_sync(self, query: str, limit: int = 4) -> list[str]:
        tokens = _WORD_RE.findall(query.lower())
        tokens = [t for t in tokens if len(t) > 1][:8]
        if not tokens:
            return []
        match = " OR ".join(f'"{t}"*' for t in tokens)
        with self._lock:
            try:
                rows = self._conn.execute(
                    "SELECT content FROM chunks_fts WHERE chunks_fts MATCH ? "
                    "ORDER BY bm25(chunks_fts) LIMIT ?",
                    (match, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
        return [r[0] for r in rows]

    async def search(self, query: str, limit: int = 4) -> list[str]:
        return self.search_sync(query, limit)

    def stats(self) -> dict:
        with self._lock:
            docs = self._conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
            chunks = self._conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            files = [
                r[0]
                for r in self._conn.execute(
                    "SELECT filename FROM docs ORDER BY id"
                ).fetchall()
            ]
        return {"documents": docs, "chunks": chunks, "files": files}

    def clear(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM docs")
            self._conn.execute("DELETE FROM chunks")
            self._conn.execute("DELETE FROM chunks_fts")
            self._conn.commit()


class EmptySyllabusStore:
    async def search(self, query: str, limit: int = 4) -> list[str]:
        return []


def get_syllabus_store(db_path: Path | None = None) -> SyllabusStore:
    if db_path is None:
        return EmptySyllabusStore()
    return SQLiteSyllabusStore(db_path)
