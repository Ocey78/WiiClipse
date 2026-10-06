#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="$ROOT/native/.emsdk"
EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-4.0.23}"

for tool in git python3 cmake ninja; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required host tool: $tool" >&2
    exit 1
  fi
done

if [[ ! -d "$EMSDK_DIR/.git" ]]; then
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
git -C "$EMSDK_DIR" pull --ff-only
"$EMSDK_DIR/emsdk" install "$EMSCRIPTEN_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSCRIPTEN_VERSION"
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh"
exec "$ROOT/native/build-dolphin-wasm.sh"
