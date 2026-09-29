#!/usr/bin/env bash
# One-command launch: builds the client once, then serves everything from the
# FastAPI backend at http://127.0.0.1:8000
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

if [ ! -f "$ROOT/client/public/models/nikechan_v2.vrm" ]; then
  echo "Avatar model missing - fetching assets..."
  "$ROOT/scripts/fetch-assets.sh"
fi

echo "== building client =="
cd "$ROOT/client"
npm install --no-audit --no-fund --silent
npm run build

echo "== starting server =="
cd "$ROOT/server"
if [ ! -d .venv ]; then
  uv sync
fi
exec uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
