# Dolphin Web native core

This directory contains an experimental Emscripten build and browser host for the maintained `libretro/dolphin` frontend. The compiled core has booted original GameCube DOL and Wii WAD test programs and produced their expected video in Chromium. Broader game and device compatibility remains experimental.

The source is pinned to commit `f8603f14e7f5a090e6693857d625a55ea9330534`. The browser host requests Dolphin's **Cached Interpreter**, disables dual-core CPU emulation, fastmem/fastmem arena and DSP JIT, and selects the **Software Renderer**. These browser-compatible settings can be slow; actual iOS device performance is unverified.

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

## Deploying a verified core

Core binaries belong in a versioned GitHub release, not in Git. The native workflow must pass its `EXPECT_CORE_READY=1` browser check before publishing them. Publish the exact `dolphin-core.js`, `dolphin-core.wasm`, `dolphin-core.data`, and any generated `dolphin-core.worker.js` or `dolphin-core.<name>.worker.js` files from that successful run. Do not use the `dolphin-browser-core-unverified` diagnostic artifact. Workflow artifacts expire; release assets provide the durable download used by future frontend deployments.

Publish `dolphin-browser-source.tar.gz` alongside the binaries. It should retain the matching patched Dolphin source, recursive dependency source and license files, and the exact browser host, patches, and build instructions. Record the frontend commit, pinned Dolphin commit, Emscripten version, and successful workflow run. Keep this source archive on the release rather than copying it into the deployed site.

After verification and publication, commit the small `native/core-release.json` manifest. Its schema is:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `tag` | Exact versioned release tag; letters, digits, dots, underscores, and hyphens only, starting with a letter or digit |
| `hostCommit`, `dolphinCommit` | Full 40-character source commit hashes |
| `emscripten` | Exact compiler version, such as `4.0.23` |
| `runId` | Successful native workflow run ID, as a positive integer or numeric string |
| `source` | `{ "name": "dolphin-browser-source.tar.gz", "sha256": "<64-character SHA-256>" }` |
| `files` | Array of `{ "name": "<core asset filename>", "sha256": "<64-character SHA-256>" }` for every generated runtime file |

Do not create the manifest before a real core has passed the boot check. The three JavaScript/WASM/data assets are required; worker assets are optional according to the compiler output. The manifest pins the actual file hashes, not a `latest` release URL or an expiring workflow artifact.

Before the normal frontend build, restore the pinned core with Node 24:

```bash
node scripts/fetch-core.mjs
npm run verify
EXPECT_CORE_READY=1 npm run test:browser
```

The downloader derives all asset URLs from `https://github.com/Ocey78/WiiClipse/releases/download/<tag>/<name>`. It validates the manifest and streams every runtime file through SHA-256 verification before replacing `public/core/`. A failed download, invalid manifest, or hash mismatch exits unsuccessfully and preserves the previous core directory. The installed `public/core/core-release.json` records provenance and the matching source archive URL; the source archive itself is not downloaded or rehashed by this command.

When the manifest is absent, the downloader explicitly skips release acquisition, makes no requests, and preserves any local native build. This permits the frontend to build before the first verified release exists. Once a manifest is committed, a failed acquisition must stop the Pages job. Run the actual-core browser probe on the assembled `dist/` before uploading the Pages artifact. This keeps later frontend pushes from replacing the site with a build that silently omits its core. Upgrade or roll back by committing the manifest for the chosen verified release.

## Current milestone

[Native build 37424761412](https://github.com/Ocey78/WiiClipse/actions/runs/37424761412), from frontend commit `d27e1c8`, passed compilation, host tests, frontend checks, and actual-core Chromium boot checks. The original GameCube DOL and synthetic Wii WAD each emitted the expected 640 × 240 frame with distinct stripe orders. This verifies real interpreter execution and video presentation, plus the WAD's temporary NAND installation and title launch.

The build's core and corresponding source use release tag [`core-d27e1c8f3860-37424761412`](https://github.com/Ocey78/WiiClipse/releases/tag/core-d27e1c8f3860-37424761412). Pages acquires the release chosen by `native/core-release.json`; publishing a core release alone does not change the live site.

The **Build experimental Dolphin core** GitHub Actions workflow can be run manually. It pins Emscripten 4.0.23 and retains compiler and browser logs. A successful compile saves `dolphin-browser-core-unverified` for diagnostics; this artifact must not be deployed without passing the browser check. The separate `dolphin-browser-core` artifact requires compilation, host tests, frontend verification, and browser boot checks to succeed. The browser check requires the compiled module to initialize and render distinct expected pixels from original GameCube DOL and Wii WAD programs in `native/tests/`. The workflow then publishes the verified core and its corresponding source as a versioned prerelease. Selecting its manifest for Pages deployment remains a separate committed change.

The pinned Emscripten runtime supplies `/dev/shm` through MEMFS. With fastmem disabled, the Cached Interpreter uses nonoverlapping physical-memory views and direct RAM pointers; wasm32 also skips the 64-bit JIT memory arena. Both probes booted with this configuration; larger titles still need memory-use testing.

The WAD boot path installs the package into the emulated NAND and launches its title. The browser's persistent save mount includes that NAND under `/dolphin/save/User/Wii`. Invalid packages and packages without a bootable title can fail to load. The synthetic probe establishes this path works in Chromium; individual Wii titles still require testing.

Commercial game compatibility, broader homebrew/WAD coverage, audio, controller behavior, stop/restart, save persistence, and emulation on an actual iPhone/iPad remain unverified. The probes contain no commercial games or firmware and do not establish those capabilities.
