# Dolphin Web — iOS 18+

Dolphin Web is a **client-side** GameCube browser port project targeting Safari on iOS/iPadOS 18+. It uses a PWA frontend, a dedicated Web Worker, Emscripten/WebAssembly, WebGL2 for presentation, WebAudio, browser-local saves, touch controls, and the Gamepad API. There is no remote Dolphin server and no game streaming.

## What is implemented

The web runtime now has a real Dolphin integration boundary built around the maintained `libretro/dolphin` frontend. Selected ISO/GCM/DOL/ELF files are sent to the emulator worker as browser `File` objects and mounted with Emscripten WORKERFS instead of being copied into a giant JavaScript `ArrayBuffer`. The worker mounts persistent saves with IDBFS, forwards controller state into a native C++ frontend, receives XRGB8888 software-rendered frames, sends them to WebGL2, and queues stereo audio through WebAudio.

The native browser host forces compatibility-first settings for a normal Safari web app: Dolphin Cached Interpreter, single-core CPU emulation, fastmem disabled, fastmem arena disabled, DSP JIT disabled, 1x EFB, and the Software Renderer. This is intentionally slower than native Dolphin, but it avoids requiring native executable-memory/JIT privileges.

## Build the browser app

```bash
npm test
npm run build
npm start
```

On Windows you can run `build-ios-web.bat` and `run-local.bat`. For the native core, `build-core-wsl.bat` bootstraps Emscripten in WSL and runs the pinned Dolphin build automatically.

## Build the real Dolphin WASM core

Activate an Emscripten SDK, then run:

```bash
./native/build-dolphin-wasm.sh
npm run build
```

The native build pins `libretro/dolphin` to commit `f8603f14e7f5a090e6693857d625a55ea9330534`, applies `native/patches/0001-dolphin-web-emscripten.patch`, injects `native/BrowserHost.cpp`, and writes the resulting Emscripten artifacts to `public/core/`.

See [`native/README.md`](native/README.md) for prerequisites and hosting requirements.

## iOS 18 hosting

The native core is linked with WebAssembly pthread support because Dolphin internally uses C++ threading primitives. The site therefore must be served over HTTPS (or localhost) with COOP/COEP cross-origin isolation enabled. The included Node server sends the required headers.

Add the HTTPS deployment to the iPhone Home Screen for the PWA-style experience. Game files and saves stay client-side.

## Current verification boundary

The JavaScript worker/frontend, native ABI source, build patch, static PWA build, and automated tests are verifiable in this repository. The current execution environment does **not** contain `emcc` and its shell cannot reach GitHub, so a compiled `dolphin-core.wasm` is not included or falsely represented as tested. Run the native build on a machine with Emscripten and GitHub access to perform the first real GameCube homebrew/ISO boot test.
