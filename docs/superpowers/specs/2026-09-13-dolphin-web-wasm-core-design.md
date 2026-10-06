# Dolphin Web WASM Core Design

## Goal

Turn the iOS 18+ PWA shell into a real, entirely client-side Dolphin integration without relying on iOS native JIT privileges or a streaming server.

## Native source boundary

Use the maintained `libretro/dolphin` frontend rather than DolphinQt/DolphinNoGUI. It already exposes a small `retro_*` API around Dolphin's core, boot, input, audio, and video systems. Pin the source commit so our Emscripten patch remains reproducible.

The browser adds `BrowserHost.cpp`, which implements the frontend callbacks and exports a small Emscripten ABI (`dweb_init`, `dweb_load_game`, `dweb_run_frame`, input setters, unload, shutdown). The browser frontend forces Cached Interpreter, single-core CPU emulation, no fastmem, no DSP JIT, and Software Renderer.

## Browser runtime

Run the Emscripten module inside a dedicated module Worker. Mount user-selected files with WORKERFS under `/content`. Mount IDBFS under `/dolphin/save`. Preload Dolphin `Data/Sys` into `/dolphin/system/dolphin-emu/Sys` at link time. Transfer software-rendered XRGB8888 frames from the worker to the main thread and upload them to a WebGL2 texture. Transfer interleaved signed 16-bit stereo audio to WebAudio.

## Hosting

Compile the full target with `-pthread` because Dolphin uses threading primitives internally. Require HTTPS/localhost plus COOP `same-origin` and COEP `require-corp`. The first milestone uses WebGL2 presentation and does not attempt Dolphin's native OGL backend through a libretro hardware context.

## Verification boundary

Automated tests cover the JS/native ABI contract and build configuration. A real boot claim requires compiling the pinned source with Emscripten and successfully running a DOL/ELF or GameCube disc image in Safari; source integration alone is not counted as emulator compatibility.
