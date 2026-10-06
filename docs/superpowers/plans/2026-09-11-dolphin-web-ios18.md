# Dolphin Web iOS18 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a truthful, runnable iOS 18+ client-side PWA shell prepared for a Dolphin-derived WebAssembly core.

**Architecture:** Static ES-module PWA. Browser services are isolated behind small modules: capability detection, game metadata parsing, input state, core bridge, storage, and renderer. The core bridge exposes a stable API now and can later bind to Emscripten/WASM exports without changing the UI.

**Tech Stack:** HTML5, CSS, JavaScript ES modules, WebGL2, Service Worker, IndexedDB, Gamepad API, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-11-dolphin-web-ios18-design.md`

## Global Constraints
- Target iOS 18.0+ Safari.
- Entirely client-side; no streaming backend.
- WebGL2 is the baseline renderer.
- GameCube-first architecture.
- Do not claim emulation is active unless a real WASM core is loaded.

---

### Task 1: Capability Detection
**Files:** Create `src/capabilities.js`; Test `tests/capabilities.test.js`
**Interfaces:** Produces `detectCapabilities(env): CapabilityInfo`.
- [ ] Write a failing test for WebGL2, WebGPU, gamepad, and service-worker capability flags.
- [ ] Run the test and verify failure.
- [ ] Implement `detectCapabilities`.
- [ ] Run tests and verify pass.

### Task 2: Game Metadata
**Files:** Create `src/game-file.js`; Test `tests/game-file.test.js`
**Interfaces:** Produces `classifyGameFile(fileName, size): GameDescriptor`.
- [ ] Write failing tests for ISO/GCM acceptance and unsupported formats.
- [ ] Run and verify failure.
- [ ] Implement classifier.
- [ ] Run and verify pass.

### Task 3: Input State
**Files:** Create `src/input-state.js`; Test `tests/input-state.test.js`
**Interfaces:** Produces `InputState` with button/axis setters and snapshot().
- [ ] Write failing normalization/state tests.
- [ ] Run and verify failure.
- [ ] Implement minimal state container.
- [ ] Run and verify pass.

### Task 4: Core Bridge
**Files:** Create `src/core-bridge.js`; Test `tests/core-bridge.test.js`
**Interfaces:** Produces `DolphinCoreBridge` with `load`, `isReady`, `bootGame`, `setInput`.
- [ ] Write failing tests proving unavailable core cannot falsely boot.
- [ ] Run and verify failure.
- [ ] Implement explicit ready-state bridge.
- [ ] Run and verify pass.

### Task 5: PWA UI + WebGL2 Shell
**Files:** Create `public/index.html`, `public/styles.css`, `src/app.js`, `src/webgl-renderer.js`, `public/manifest.webmanifest`, `public/sw.js`.
**Interfaces:** Consumes all earlier modules and exposes the interactive app.
- [ ] Add a static integration test validating required files and truthful core status copy.
- [ ] Run and verify failure.
- [ ] Implement UI, file picker, touch controls, capability badges, WebGL2 canvas, and service-worker registration.
- [ ] Run full test suite.

### Task 6: Build/Run Packaging
**Files:** Create `package.json`, `README.md`, `run-local.bat`, `run-local.sh`, `build-ios-web.bat`.
- [ ] Add package-script smoke test.
- [ ] Run and verify failure.
- [ ] Add zero-dependency local static server and packaging scripts.
- [ ] Run all tests and zip source.
