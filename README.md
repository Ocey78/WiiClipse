# Dolphin Web — iOS 18+

**WiiClipse site:** https://ocey78.github.io/WiiClipse/

The browser app is published automatically after its tests and browser startup checks pass. The native Dolphin core is experimental and is not included in the site yet; opening the site is not a claim that GameCube games can boot.

Dolphin Web is a **client-side** GameCube/Wii browser port project targeting Safari on iOS/iPadOS 18+. It uses a PWA frontend, a dedicated Web Worker, Emscripten/WebAssembly, WebGL2 for presentation, WebAudio, browser-local saves, touch controls, and the Gamepad API. There is no remote Dolphin server and no game streaming.

The file picker accepts GameCube ISO/GCM images, DOL/ELF homebrew, and bootable **Wii WAD channel packages** (not Doom WAD files). Dolphin's WAD boot path installs into the emulated NAND under browser-local save storage before launching the title. File selection does not guarantee title compatibility; actual boot requires the native core.

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

For the browser smoke check, run `npm ci`, `npx playwright install chromium`, then `npm run verify && npm run test:browser`. It serves the built app below `/WiiClipse/` without server isolation headers and checks first-visit startup, shared-memory availability, file selection, reload, and the offline app shell. It does not simulate a successful native game boot.

## GitHub Pages

`.github/workflows/pages.yml` tests and deploys `dist/` whenever `main` changes. The repository's Pages source is **GitHub Actions**. Relative asset paths support the `/WiiClipse/` project URL.

The service worker adds the isolation headers required for shared memory on this static host. The first visit may reload once before the app starts. Offline caching covers the app shell; it does not cache game files or the native core. Games remain on your device.

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

The JavaScript worker/frontend, source-level native ABI checks, static PWA build, and real Chromium startup checks are tested. A compiled `dolphin-core.wasm` is not included, and actual GameCube boot or iOS/Safari emulation has not been verified. The manual **Build experimental Dolphin core** workflow attempts the native compilation separately and preserves its build logs. See `native/README.md` for the remaining porting gaps; compiling the core alone does not establish that it can boot a game.
