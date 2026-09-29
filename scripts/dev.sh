#!/usr/bin/env bash
# Development: Vite dev server (5173, hot reload) + FastAPI backend (8000).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

trap 'kill 0' EXIT

if [ ! -f "$ROOT/client/public/models/nikechan_v2.vrm" ]; then
  echo "Avatar model missing - fetching assets..."
  "$ROOT/scripts/fetch-assets.sh"
fi

cd "$ROOT/server"
if [ ! -d .venv ]; then
  uv sync
fi
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 &

cd "$ROOT/client"
npm install --no-audit --no-fund --silent
npm run dev &

wait
