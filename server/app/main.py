"""FastAPI app: WebSocket endpoint hosting the tutor session."""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .llm import get_provider
from .memory import MemoryStore, get_syllabus_store
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
syllabus = get_syllabus_store()
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


if __name__ == "__main__":
    main()
