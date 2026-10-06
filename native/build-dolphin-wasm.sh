#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$ROOT/native"
WORK_DIR="$NATIVE_DIR/.build"
SOURCE_DIR="$WORK_DIR/dolphin"
BUILD_DIR="$WORK_DIR/wasm"
OUT_DIR="$ROOT/public/core"
DOLPHIN_REPO="https://github.com/libretro/dolphin.git"
DOLPHIN_COMMIT="f8603f14e7f5a090e6693857d625a55ea9330534"
BUILD_PROFILE="${DWEB_BUILD_PROFILE:-optimized}"
COMPILER_FLAGS="-pthread"
STACK_OVERFLOW_CHECK=2
case "$BUILD_PROFILE" in
  baseline) ;;
  optimized)
    # Full LTO keeps LLVM IR across translation units; SIMD enables vectorization
    # of generic image/audio loops without selecting a native x86/ARM backend.
    # Upstream ENABLE_LTO remains off because CMake IPO may select thin LTO;
    # these explicit full-LTO flags are applied at compilation and final linking.
    COMPILER_FLAGS+=" -msimd128 -flto=full"
    STACK_OVERFLOW_CHECK=1
    ;;
  *) echo "Unknown DWEB_BUILD_PROFILE: $BUILD_PROFILE" >&2; exit 1 ;;
esac

for tool in git cmake ninja emcc em++ emcmake; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool" >&2
    echo "Activate the Emscripten SDK (emsdk_env.sh) and try again." >&2
    exit 1
  fi
done

mkdir -p "$WORK_DIR"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git init "$SOURCE_DIR"
  git -C "$SOURCE_DIR" remote add origin "$DOLPHIN_REPO"
fi

git -C "$SOURCE_DIR" fetch --depth 1 origin "$DOLPHIN_COMMIT"
git -C "$SOURCE_DIR" checkout --force --detach "$DOLPHIN_COMMIT"
git -C "$SOURCE_DIR" clean -fdx
git -C "$SOURCE_DIR" submodule sync --recursive
git -C "$SOURCE_DIR" submodule update --init --force --recursive --depth 1 --jobs 8
# Numbered patches also adapt pinned dependencies inside this disposable build clone.
git -C "$SOURCE_DIR" submodule foreach --recursive 'git clean -fdx'

cp "$NATIVE_DIR/BrowserHost.cpp" "$SOURCE_DIR/Source/Core/DolphinLibretro/BrowserHost.cpp"
for patch in "$NATIVE_DIR"/patches/[0-9][0-9][0-9][0-9]-*.patch; do
  git -C "$SOURCE_DIR" apply "$patch"
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# The full core is built with pthread support because Dolphin's internals use C++
# threading primitives even though the browser frontend forces single-core CPU emulation.
emcmake cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja \
  -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$COMPILER_FLAGS" \
  -DCMAKE_CXX_FLAGS="$COMPILER_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$COMPILER_FLAGS" \
  -DDWEB_STACK_OVERFLOW_CHECK="$STACK_OVERFLOW_CHECK" \
  -DENABLE_GENERIC=ON \
  -DLIBRETRO=ON \
  -DENABLE_QT=OFF \
  -DENABLE_NOGUI=OFF \
  -DENABLE_CLI_TOOL=OFF \
  -DENABLE_TESTS=OFF \
  -DENABLE_LLVM=OFF \
  -DENABLE_VULKAN=OFF \
  -DENABLE_SDL=OFF \
  -DENABLE_CUBEB=OFF \
  -DENABLE_ALSA=OFF \
  -DENABLE_PULSEAUDIO=OFF \
  -DENABLE_EGL=OFF \
  -DENABLE_X11=OFF \
  -DENABLE_AUTOUPDATE=OFF \
  -DENABLE_ANALYTICS=OFF \
  -DENABLE_LTO=OFF \
  -DENABLE_CCACHE=ON \
  -DUSE_UPNP=OFF \
  -DUSE_MGBA=OFF \
  -DUSE_RETRO_ACHIEVEMENTS=OFF \
  -DUSE_DISCORD_PRESENCE=OFF \
  -DENCODE_FRAMEDUMPS=OFF \
  -DUSE_SYSTEM_LIBS=OFF

# Collect independent compiler errors in one attempt; do not package partial output.
cmake --build "$BUILD_DIR" --target dolphin_libretro --parallel -- -k 0

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

mapfile -t artifacts < <(find "$BUILD_DIR" -type f \( \
  -name 'dolphin-core.js' -o \
  -name 'dolphin-core.wasm' -o \
  -name 'dolphin-core.data' -o \
  -name 'dolphin-core.worker.js' -o \
  -name 'dolphin-core.*.worker.js' \
\) -print)

if [[ ${#artifacts[@]} -eq 0 ]]; then
  echo "Build finished but no dolphin-core artifacts were found." >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  cp "$artifact" "$OUT_DIR/"
done

if [[ ! -f "$OUT_DIR/dolphin-core.js" || ! -f "$OUT_DIR/dolphin-core.wasm" ]]; then
  echo "Expected dolphin-core.js and dolphin-core.wasm were not produced." >&2
  exit 1
fi

echo "Dolphin WASM core built from $DOLPHIN_COMMIT"
echo "Build profile: $BUILD_PROFILE ($COMPILER_FLAGS, stack checks $STACK_OVERFLOW_CHECK)"
echo "Output: $OUT_DIR"
