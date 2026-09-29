#!/usr/bin/env bash
# Downloads model assets that are not kept in git:
#  - Nike-chan avatar (VRM 1.0; official terms: tegnike/nikechan-assets -
#    personal use, no redistribution of the model itself)
#  - Kokoro TTS model + voices (Apache 2.0)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/client/public/models" "$ROOT/server/cache/kokoro"

echo "== Avatar (Nike-chan, VRM 1.0) =="
curl -fL -o "$ROOT/client/public/models/nikechan_v2.vrm" \
  "https://raw.githubusercontent.com/tegnike/nikechan-assets/main/vrms/nikechan_v2.vrm"

echo "== Kokoro TTS =="
if [ ! -f "$ROOT/server/cache/kokoro/kokoro-v1.0.onnx" ]; then
  curl -fL -o "$ROOT/server/cache/kokoro/kokoro-v1.0.onnx" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
fi
if [ ! -f "$ROOT/server/cache/kokoro/voices-v1.0.bin" ]; then
  curl -fL -o "$ROOT/server/cache/kokoro/voices-v1.0.bin" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
fi

echo "Done."
