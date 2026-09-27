"""FastAPI app: WebSocket endpoint hosting the tutor session."""

from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .llm import get_provider
from .memory import MemoryStore, SQLiteSyllabusStore, get_syllabus_store
from .protocol import ClientMessageAdapter
from .tts import TTSEngine
from .tutor import TutorBrain

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")

app = FastAPI(title="Waifu Tutor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

memory = MemoryStore(settings.data_dir / "tutor.db")
provider = get_provider(settings)
tts = TTSEngine(settings)
syllabus = get_syllabus_store(settings.data_dir / "syllabus.db")
brain = TutorBrain(settings, provider, tts, memory, syllabus)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "provider": settings.provider,
        "model": settings.llm_model,
        "tts": tts.available,
        "voice": tts.voice,
    }


def _extract_text(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n".join(
            page.extract_text() or "" for page in reader.pages
        )
    if name.endswith((".txt", ".md", ".markdown", ".rst", ".csv", ".json")):
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.decode("latin-1", errors="replace")
    raise ValueError("unsupported file type (use PDF or text files)")


@app.post("/api/syllabus")
async def upload_syllabus(file: UploadFile) -> dict:
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        return {"ok": False, "error": "file too large (50 MB max)"}
    try:
        text = _extract_text(file.filename or "upload", data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception:
        log.exception("document extraction failed")
        return {"ok": False, "error": "could not read document"}

    store = syllabus
    if not isinstance(store, SQLiteSyllabusStore):
        return {"ok": False, "error": "syllabus store not configured"}
    chunks = await asyncio.to_thread(
        store.add_document, file.filename or "upload", text
    )
    return {"ok": True, "chunks": chunks, **store.stats()}


@app.get("/api/syllabus")
async def syllabus_stats() -> dict:
    store = syllabus
    if not isinstance(store, SQLiteSyllabusStore):
        return {"documents": 0, "chunks": 0, "files": []}
    return store.stats()


@app.delete("/api/syllabus")
async def syllabus_clear() -> dict:
    store = syllabus
    if not isinstance(store, SQLiteSyllabusStore):
        return {"ok": False}
    await asyncio.to_thread(store.clear)
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json({"t": "hello", "provider": settings.provider})
    turn_task: asyncio.Task | None = None

    async def forward(stream) -> None:
        try:
            async for event in stream:
                await ws.send_json(event)
        except asyncio.CancelledError:
            # the brain was interrupted: tell the client, keep the socket alive
            await ws.send_json({"t": "interrupted"})
            raise

    try:
        while True:
            raw = await ws.receive_json()
            try:
                msg = ClientMessageAdapter.validate_python(raw)
            except Exception:
                await ws.send_json(
                    {"t": "error", "message": "invalid message"}
                )
                continue

            if msg.t == "interrupt":
                brain.interrupt()
                continue

            if msg.t == "settings_update":
                brain.update_tutor_settings(msg.settings)
                await ws.send_json({"t": "settings_ok"})
                continue

            # a new user message or answer supersedes any active turn
            if turn_task is not None and not turn_task.done():
                turn_task.cancel()
                await asyncio.gather(turn_task, return_exceptions=True)

            if msg.t == "user_message":
                turn_task = asyncio.create_task(forward(brain.run_turn(msg.text)))
            elif msg.t == "answer":
                turn_task = asyncio.create_task(
                    forward(brain.run_answer_turn(msg.question_id, msg.text))
                )
    except WebSocketDisconnect:
        brain.interrupt()
        log.info("client disconnected")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


# Serve the built client in production (npm run build), after all routes.
_CLIENT_DIST = Path(__file__).resolve().parents[2] / "client" / "dist"
if _CLIENT_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_CLIENT_DIST), html=True), name="client")


if __name__ == "__main__":
    main()
