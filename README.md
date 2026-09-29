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

# 2. Configure
cp .env.example .env          # add LLM_API_KEY (DeepSeek or any OpenAI-compatible API)

# 3. Run (production: builds client, serves everything on :8000)
scripts/run.sh

# ...or develop with hot reload (client :5173, server :8000)
scripts/dev.sh
```

Without an API key the server runs in `mock` mode (a canned lesson) so the
full experience can be tested offline — the app shows a notice when this
happens.

### Manual setup

```bash
cd server && uv sync && uv run uvicorn app.main:app --port 8000   # server
cd client && npm install && npm run dev                            # client (dev)
```

## Avatar

Nike-chan (VRM 1.0, official terms at tegnike/nikechan-assets:
personal use permitted, the model itself is not redistributed).

## Features

- 3D anime tutor (VRM 1.0) with procedural idle life: blinking, breathing,
  spring-bone hair, gaze tracking (me / windows / random), saccades, nods,
  pointing, hand gestures, and phoneme-timed lip sync from local TTS.
- Teaching brain (DeepSeek or any OpenAI-compatible API) that explains,
  derives, gives examples, checks understanding, evaluates answers, and
  adapts using a per-concept mastery store.
- Spatial floating windows: markdown (with mermaid diagrams), equations
  (KaTeX), graphs (Plotly, safe math parser), questions, tables, code,
  images, and a drawable whiteboard. Draggable, resizable, closable.
- Local expressive TTS (Kokoro, CPU) with streaming playback and interrupt.
- Syllabus upload (PDF/text) with FTS retrieval injected into each lesson.
- Settings: name, personality, teaching style, depth, difficulty, question
  frequency, response length, custom instructions, voice, speech speed,
  graphics quality.

## Docs

- `docs/architecture.md` — design decisions, event protocol, roadmap.
- `instructions.md` — original project brief.
