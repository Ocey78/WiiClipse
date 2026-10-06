# Dolphin Web native core

This directory contains an experimental Emscripten build and browser host for the maintained `libretro/dolphin` frontend. It has not yet produced a verified browser emulator core. A successful web build or frontend test run does not establish that GameCube or Wii software can boot.

The source is pinned to commit `f8603f14e7f5a090e6693857d625a55ea9330534`. The patch has been checked against that exact commit. The browser host requests Dolphin's **Cached Interpreter**, disables dual-core CPU emulation, fastmem/fastmem arena and DSP JIT, and selects the **Software Renderer**. These settings are intended for a browser port; they are not proof of iOS or game compatibility.

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

The web frontend, worker, filesystem mounts, audio/video callbacks, input ABI, and initial Dolphin build patch are implemented. The native tests currently check source structure, not compiled execution. The **Build experimental Dolphin core** GitHub Actions workflow can be run manually; it pins Emscripten 4.0.23, retains the build log, and uploads core files only if compilation succeeds. It does not publish a site or certify game boot.

Source inspection at the pinned revision found additional porting work beyond the existing CMake patch:

- `Source/Core/DolphinLibretro/Video.h` constructs the software graphics backend with `SWOGLWindow::Create`. That path still uses the libretro OpenGL context, whose initialization requires a hardware-context reset. The browser host currently rejects hardware rendering and does not supply that reset. The software presentation path therefore needs browser-specific implementation and execution tests.
- `Source/Core/Common/CMakeLists.txt` selects `MemArenaUnix.cpp` for Emscripten. This uses `shm_open`, `mmap`, and mapping protection; disabling fastmem does not remove the physical-memory allocation path. Its browser behavior remains unverified.

Completion requires a successful native build, loading that module in a cross-origin-isolated browser, and a real boot test with a suitable homebrew or user-provided game, including audio, video, input, and stop/restart. No compiled core or game-boot result is claimed by this scaffold.
