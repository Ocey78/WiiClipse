# Dolphin Web native core

This directory turns the maintained `libretro/dolphin` frontend into an Emscripten module for the browser shell.

The source is pinned to commit `f8603f14e7f5a090e6693857d625a55ea9330534` so the patch is reproducible. The browser host deliberately requests Dolphin's **Cached Interpreter**, disables dual-core CPU emulation, fastmem/fastmem arena and DSP JIT, and starts with the **Software Renderer**. This is the compatibility-first path for iOS Safari where native executable-memory JIT is not available to a normal web app.

## Prerequisites

Install Git, CMake, Ninja, Python, and the Emscripten SDK. Activate the SDK so `emcc`, `em++`, and `emcmake` are on PATH.

On macOS/Linux/WSL/Git Bash:

```bash
./native/build-dolphin-wasm.sh
npm test
npm run build
npm start
```

For the easiest Windows path, double-click `build-core-wsl.bat`. It uses WSL, bootstraps a local Emscripten SDK under `native/.emsdk`, builds the pinned Dolphin core, then packages `dist/`.

With an already-configured PowerShell/Git Bash environment you can also run:

```powershell
./native/build-dolphin-wasm.ps1
```

The native build writes `dolphin-core.js`, `dolphin-core.wasm`, its preloaded `Sys` data file, and any pthread worker files to `public/core/`. The normal web build then copies them into `dist/core/`.

## Hosting requirements

The core is built with WebAssembly threads because Dolphin's internals use threading primitives. Serve the site over HTTPS (or localhost) with both headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

The included Node server sends those headers plus `Cross-Origin-Resource-Policy: same-origin`.

## Current milestone

The web frontend, worker, filesystem mounts, audio/video callbacks, input ABI, and reproducible Dolphin build patch are implemented. A real `dolphin-core.wasm` must still be compiled on a machine with Emscripten and network access; this execution environment does not have `emcc` and cannot clone GitHub from the shell, so the native binary itself is not falsely bundled as if it had been verified here.
