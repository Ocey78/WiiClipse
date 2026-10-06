# Dolphin Web native core

This directory contains an experimental Emscripten build and browser host for the maintained `libretro/dolphin` frontend. It has not yet produced a verified browser emulator core. A successful web build or frontend test run does not establish that GameCube or Wii software can boot.

The source is pinned to commit `f8603f14e7f5a090e6693857d625a55ea9330534`. The patches have been checked against that exact commit. The browser host requests Dolphin's **Cached Interpreter**, disables dual-core CPU emulation, fastmem/fastmem arena and DSP JIT, and selects the **Software Renderer**. These settings are intended for a browser port; they are not proof of iOS or game compatibility.

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

The web frontend, worker, filesystem mounts, audio/video callbacks, input ABI, and browser patches are implemented. The software renderer presents pixels without a desktop OpenGL window. Game loading checks native startup and returns an error if initialization fails; stopping a game resets the native startup state for another load. Host-compiled tests exercise frame conversion and the browser-host boot contract. These tests do not execute the emulator.

The **Build experimental Dolphin core** GitHub Actions workflow can be run manually. It pins Emscripten 4.0.23 and retains compiler and browser logs. A successful compile saves `dolphin-browser-core-unverified` for diagnostics; this artifact must not be deployed without passing the browser check. The separate `dolphin-browser-core` artifact requires compilation, host tests, frontend verification, and browser boot checks to succeed. The browser check requires the compiled module to initialize and render the expected pixels from an original GameCube DOL test program in `native/tests/boot-probe.mjs`. The workflow does not publish a site.

The pinned Emscripten runtime supplies `/dev/shm` through MEMFS. With fastmem disabled, the Cached Interpreter uses nonoverlapping physical-memory views and direct RAM pointers; wasm32 also skips the 64-bit JIT memory arena. These source checks do not establish a memory-port blocker. Real boot and memory-use tests are still needed.

The pinned upstream libretro core accepts Wii `.wad` packages. Its WAD boot path installs the package into the emulated NAND and launches its title. The browser's persistent save mount includes that NAND under `/dolphin/save/User/Wii`. Invalid packages and packages without a bootable title can fail to load. This source-level support does not establish browser compatibility for an individual Wii title.

Completion still requires a successful native build and browser boot run. Broader compatibility also needs suitable homebrew or user-provided games covering audio, input, Wii WAD loading, and stop/restart. No compiled core or game-boot result is claimed yet.
