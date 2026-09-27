# Waifu Tutor

A personal AI tutor: a real-time 3D anime character who teaches you interactively with
speech, expressions, gestures, and floating visual aids (equations, graphs, diagrams,
questions) inside a minimal virtual space.

## Architecture

- **client/** — Vite + TypeScript + Three.js + `@pixiv/three-vrm`. Renders the 3D
  environment, the character, and the spatial floating-window UI (CSS3D).
- **server/** — Python (FastAPI). Hosts the tutor "brain": LLM integration
  (OpenAI-compatible, DeepSeek by default), validated event protocol, local TTS
  (Kokoro), memory/progress store (SQLite), and syllabus retrieval.

The LLM never controls the app directly. It emits validated JSON events
(`speech`, `action: create_window / close_window / look_at / expression / ...`),
which the app interprets and executes safely. See `docs/architecture.md`.

## Requirements

- Node 22+, Python 3.12 (`uv` recommended), and a WebGPU/WebGL2-capable browser.
- GPU is used for rendering only; TTS runs on CPU (Kokoro ~ small footprint).

## Setup

```bash
# 1. Model asset (once)
scripts/fetch-assets.sh

# 2. Server
cd server
uv sync                # or: uv venv && uv pip install -e .
cp ../.env.example ../.env   # then add LLM_API_KEY
uv run uvicorn app.main:app --port 8000

# 3. Client
cd client
npm install
npm run dev            # http://localhost:5173
```

Without an API key the server runs in `mock` mode so the full experience can be
tested offline.

## Docs

- `docs/architecture.md` — design decisions, event protocol, roadmap.
- `instructions.md` — original project brief.
