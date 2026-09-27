# Architecture

## Goals

A believable 3D anime tutor in a minimal virtual room. The user types a request; the
tutor explains with speech, facial expression, gaze, gestures, and spatial floating
windows (equations, graphs, questions, ...), asks questions, evaluates answers, and
tracks learning progress. Runs comfortably on an RTX 3060 Ti 8 GB with low RAM.

## Stack & rationale

| Concern          | Choice                                        | Why                                                                 |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Rendering        | Three.js + `@pixiv/three-vrm` (WebGL2/WebGPU) | Best ecosystem for VRM anime avatars: expressions, spring bones, look-at, procedural animation. GPU-accelerated in browser. |
| Floating UI      | CSS3DRenderer (real DOM in 3D space)          | Crisp text, native interactions (forms, scroll), KaTeX/Mermaid/Plotly work unchanged. Depth-sorting edge cases acceptable. |
| LLM             | OpenAI-compatible API (DeepSeek default)       | Cheap, capable, swappable provider. Streaming via SSE-style protocol. |
| TTS              | Kokoro (ONNX, CPU)                            | High-quality expressive voice, ~small model, no VRAM use, fast on 6 cores. |
| Backend          | FastAPI + WebSocket                           | One duplex channel for events + audio; async streaming pipeline. |
| Memory/progress  | SQLite (+ embeddings via fastembed, CPU)       | Structured learning state instead of raw chat dumps. |
| Charts/equations | Plotly, KaTeX, Mermaid, Markdown              | Mature, render in DOM windows. |

Deliberately **not** used: a game engine (heavy asset pipeline, no DOM UI),
local LLM (VRAM budget belongs to rendering/TTS), torch-based TTS (RAM/VRAM heavy).

## The event protocol (AI → app)

The LLM is prompted to emit newline-delimited JSON events. Each line is parsed and
validated by pydantic before anything happens. Invalid lines are dropped (never
executed). No code execution from the LLM exists anywhere.

```
{"t":"speech","text":"..."}                          # spoken prose, streamed
{"t":"action","a":{"type":"create_window","win":{...}}}
{"t":"action","a":{"type":"close_window","id":...}}
{"t":"action","a":{"type":"look_at","target":"me|window:<id>|board|random"}}
{"t":"action","a":{"type":"gesture","name":"point|nod|shake|wave|think",...}}
{"t":"action","a":{"type":"expression","name":"happy|thinking|surprised|..."}}
{"t":"action","a":{"type":"ask_question","...prompt, answer_type"}}
{"t":"action","a":{"type":"focus_window","id":...}}
```

Window payloads carry `kind` (`text|markdown|equation|graph|question|image|table|whiteboard`)
plus kind-specific data. The server also streams binary audio frames
(`{"t":"audio","sample_rate":24000,"chunk":base64}`) and `{"t":"utterance_end"}`.

Server → client: `hello`, `status`, `error`, plus the above. Client → server:
`user_message`, `answer`, `interrupt`, `settings_update`.

## Pipeline (one user turn)

1. Client sends `user_message` over WS.
2. Tutor brain builds context: system prompt (persona + pedagogy + progress summary)
   + retrieved syllabus snippets + conversation window.
3. LLM streams NDJSON events. Brain validates each.
4. `speech` events accumulate into sentences; TTS renders each sentence
   (Kokoro, CPU) and the server streams audio frames down the socket.
5. `action` events are forwarded to the client immediately, so the character can
   look at / gesture toward windows while audio plays.
6. `ask_question` opens an interactive window; the client's `answer` event starts
   a new turn with answer-evaluation framing.
7. The brain persists a distilled state update (concepts touched, correctness,
   hints used) to SQLite at turn end.

## Modularity

- `server/app/llm/` — provider adapters (`openai_compat`, `mock`); swap via env.
- `server/app/protocol.py` — the single source of truth for the event contract.
- `server/app/tutor/` — pedagogy, prompt assembly, turn orchestration.
- `server/app/tts/` — engine abstraction (kokoro now; piper/elevenlabs later).
- `server/app/memory/` — SQLite store + retrieval.
- `client/src/scene/` — rendering; `client/src/ui/` — HUD + window manager;
  `client/src/net/` — WS client, audio playback, lip-sync analysis.

## Performance budget

- Browser render target: ≤ 60 FPS, ~1–2 GB VRAM (one avatar + minimal scene).
- TTS: CPU, ~real-time factor 0.5–1.5 on 6 cores. No torch loaded.
- Embeddings: CPU MiniLM-class via ONNX (~100 MB RAM) for syllabus retrieval.

## Roadmap (vertical slices)

1. ✅ Scaffold + protocol + server skeleton.
2. ✅ 3D room + VRM character with idle life (blink, breathe, look-at, spring bones).
3. ✅ End-to-end: message → LLM (mock/deepseek) → TTS + speech + text window.
4. ✅ Window system: markdown/equation/graph/question/image/table/code/whiteboard,
   drag/resize/close, spatial placement.
5. ✅ Question flow with answer evaluation + progress recording; gestures & pointing.
6. ✅ Syllabus upload (PDF/text) + FTS retrieval; progress tracking; revision prompts.
7. Settings UI (basic present); polish (interruption done, lip-sync done, idle variants).

## Graph windows

Graph specs are plain JSON data: `{functions: ["x^2", "sin(x)"], x_range, labels,
annotations}` or `{x, y, style}`. Function strings are compiled by a whitelist
recursive-descent parser (`client/src/ui/mathexpr.ts`) — **never eval'd**.
Rendered with Plotly (lazy-loaded code-split chunk).

## Syllabus pipeline

Upload (PDF via pypdf / text) → paragraph chunking (1k chars, 120 overlap) →
SQLite FTS5 index → top-k retrieval per turn, injected into the system prompt
as "SYLLABUS" context. Semantic embeddings can replace the retriever later
behind the same `SyllabusStore` interface.
