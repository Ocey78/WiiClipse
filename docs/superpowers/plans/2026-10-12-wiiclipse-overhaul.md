# WiiClipse Overhaul Implementation Plan

> **For agentic workers:** Use parallel implementation for independent files, followed by integrated tests and a fresh whole-change review. Steps use checkbox syntax for tracking.

**Goal:** Improve WiiClipse's play experience, input reliability, and runtime lifecycle, then publish the tested app to GitHub Pages.

**Architecture:** Retain the buildless browser modules, worker ABI, and pinned Dolphin core. Split input ownership from session UI; serialize asynchronous worker filesystem operations. Keep all native calls behind the existing worker client.

**Tech Stack:** JavaScript ES modules, Node test runner, Playwright, WebGL2, WebAudio, Emscripten, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-12-wiiclipse-overhaul.md`

## Global Constraints

- Files remain client-side; no hosted ROMs or game uploads.
- Relative asset URLs must work under `/WiiClipse/` and offline shell caching.
- Preserve the verified native release; no unsupported performance/compatibility claims.
- User authorization includes publication to this repository's GitHub site.

## Review Focus

- Backgrounding during boot/pause cannot restart a manually paused session.
- Mixed keyboard/touch/gamepad input and disconnects cannot leave controls pressed.
- Saving and unload/title replacement cannot overlap filesystem operations or silently lose errors.
- Storage restrictions and failed browser features cannot prevent local game selection.
- Small screens, keyboard focus, fullscreen failure, and long filenames must remain usable.

### Task 1: Input ownership and complete controls

Files: `src/input-state.js`, new `src/input-controller.js`, input tests.

Interface: `createInputController({ input, document, window, navigator, onChange, onGamepad })` returns `{ reset(), setEnabled(boolean), destroy() }`. InputState setters accept an optional source identifier; clearSource and reset release state. Existing callers remain compatible.

- [x] Add failing regressions for independent sources, release, drift, nonzero gamepad slots, keyboard focus, and touch pointer capture.
- [x] Implement keyboard maps, pointer controls and stick zones, source merging, deadzone and stable quantization.
- [x] Verify unit suite and report integration contract.

### Task 2: Player design and mobile layout

Files: `public/index.html`, `public/styles.css`, `public/manifest.webmanifest`, `public/icon.svg`.

Interface: Preserve existing IDs; add `pause`, `stop`, `fullscreen`, `mute`, `volume`, `volumeValue`, `saveNow`, `saveState`, `fps`, `speed`, `sessionState`, `gamepadState`, `emptyScreen`, `dropZone`, `touchControls`, and `showTouch`. Touch stick zones use `data-stick="left|right"` with a `.stick-knob` child. Shoulder buttons use existing `data-button` names.

- [x] Implement the requested simple player with no slogans, collapsed help, accessible controls, and responsive layout.
- [x] Verify file formats, control labels, contrast, and phone layout in integrated browser checks.

### Task 3: Worker lifecycle and persistence reliability

Files: `src/dolphin-worker.js`, `src/dolphin-worker-client.js`, worker tests.

Interface: `syncSaves()` and `unloadGame()` return promises resolved on worker acknowledgment. `onSaveStatus({ state, message })` reports saving/saved/error. Older core ABI remains supported.

- [x] Write failing tests for overlapping lifecycle/save operations and cleanup failures.
- [x] Serialize asynchronous work, coalesce periodic saves, clean copied files, acknowledge save/unload results, and expose persistence errors.
- [x] Verify worker regressions and full unit suite.

### Task 4: Session controls and integration

Files: `src/app.js`, `src/audio-sink.js`, new `src/session-state.js`, session/audio/app tests, `public/sw.js`, README and browser checks.

- [x] Add failing regressions for manual/background pause, stop, audio level clamping, and file rejection.
- [x] Integrate input controller and responsive UI, implement pause/stop, fullscreen, mute/volume, drag/drop, explicit save feedback, and measured frame rate/speed.
- [x] Update cache assets/version and WiiClipse documentation.
- [x] Run unit and browser checks including native DOL/WAD probes; inspect desktop/mobile visuals.
- [x] Perform independent review and fix material findings.
- [ ] Build and commit, publish to main, verify Pages workflow and deployed site.

## Pre-publication verification

- 133 Node tests pass, including the local preview server asset paths and malformed-URL regression.
- Chromium and WebKit pass player interactions, mobile layout, real DOL/WAD/GX video probes, title replacement, first visit, reload, isolation, and offline shell checks.
- Chromium rendering/audio checks and Chromium/WebKit scheduling checks pass.
- Windows Playwright WebKit provides no Web Audio API; Linux WebKit audio remains a required Pages deployment gate.
- Independent logic and simplified-interface reviews have no outstanding material findings.
- The local preview serves the built site directly, fixing missing relative stylesheet/service-worker assets.
