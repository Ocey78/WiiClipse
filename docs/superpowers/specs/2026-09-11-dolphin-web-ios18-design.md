# Dolphin Web iOS18 Design

Client-side PWA targeting iOS 18+ Safari. WebGL2 baseline; optional WebGPU later. WASM boundary around a Dolphin-derived core; initial build provides a truthful runnable shell with local ISO/GCM file selection, touch/gamepad input, IndexedDB metadata storage, WebGL2 presentation surface, and a native-core bridge that reports unavailable until a real compiled core is supplied. No server-side emulation.

## Milestone 1
- iOS 18+ Safari/PWA
- GameCube-first architecture
- WebGL2 renderer baseline
- WebAudio-ready audio bridge
- Local file loading
- Touch controller
- Gamepad API
- Offline cache
- WASM core adapter with explicit capability detection

## Non-goals in this prototype
- Claiming commercial GameCube compatibility without a compiled Dolphin core
- Wii emulation
- RVZ decompression
- Native JIT
