# Native correctness and performance checks

Run these commands from the repository root in Bash. The native workflow builds
the pinned, patched Dolphin source at `native/.build/dolphin` and writes the
candidate core to `public/core`. Set `RUNNER_TEMP` to a writable temporary
directory when running outside GitHub Actions. Browser tests require the built
`dist` directory, complete core assets, and Playwright browsers:

```bash
npm ci
npm run verify
npx playwright install --with-deps chromium firefox
```

**Decoded integer runs.** These are the exact differential-test commands used by
the native workflow:

```bash
python3 native/tests/extract-integer-reference.py native/.build/dolphin "$RUNNER_TEMP/integer-reference.h"
c++ -std=c++20 -O2 -I native/.build/dolphin/Source/Core -I "$RUNNER_TEMP" native/tests/browser-integer.cpp -o "$RUNNER_TEMP/browser-integer"
"$RUNNER_TEMP/browser-integer"
```

The extractor reads the actual pinned instruction union, opcode tables, rotation
helper, and 27 integer handlers. The test compares the new path against those
handlers across 2,877,824 cases: opcode rejection, signed immediates, register
aliases, rotate masks, arbitrary bit patterns, and dependent runs. It also runs
the actual patched append/flush/execute methods and upstream emitter with a small
fixture to check batches of 0–96 instructions, the 32-instruction limit,
discontinuous PCs, callback distances, and exhausted output storage.

This establishes the tested register results and batch serialization. It does
not execute the complete CPU scheduler, exception machinery, debugger, or cache
invalidation. The patch leaves memory, branches, record/overflow/carry forms and
FPU instructions on their existing paths, disables batching during debugging or
stepping, and flushes before hooks and state-observing callbacks. Full Wasm builds
and browser boots remain necessary integration checks.

**Original GX probe.** `createGxBootProbe({ layers: 8 })` produces a GameCube DOL
from original PowerPC code and GX packets, with no game, firmware, or SDK binary.
It alternates red/green triangles, rejects a farther white triangle with the
depth test, alpha-blends a nearer blue triangle, copies EFB to XFB, and repeats
through the emulated FIFO. It checks sustained rendering instead of a static
framebuffer. `layers` accepts 1–256 repeated base triangles. To save a probe for
manual loading:

```bash
node native/tests/gx-boot-probe.mjs "$RUNNER_TEMP/wiiclipse-gx-probe.dol" 8
```

The workflow checks the browser staging APIs separately, then runs native boot
and title-replacement checks with real GameCube DOL, synthetic Wii WAD, and GX
probes:

```bash
node native/tests/webgl2-staging-browser.mjs
EXPECT_CORE_READY=1 SMOKE_EXPECT_GPU=1 npm run test:browser
EXPECT_CORE_READY=1 SMOKE_DISABLE_WORKER_GPU=1 npm run test:browser
EXPECT_CORE_READY=1 SMOKE_BROWSER=firefox npm run test:browser
```

The staging test verifies browser API contracts without executing Dolphin.
`SMOKE_EXPECT_GPU=1` additionally requires context creation and draws inside the
native worker. `SMOKE_DISABLE_WORKER_GPU=1` deliberately removes that capability
and requires the software fallback to render. GPU instrumentation uses the local
smoke server and cannot be combined with `SMOKE_URL`.

**Measurements.** These are the workflow's GX runs and paired CPU comparison:

```bash
mkdir -p native-performance
PERF_CASE=gx PERF_RENDERER=software PERF_FRAMES=30 PERF_OUT=native-performance/gx-software.json node tests/browser-performance.mjs
PERF_CASE=gx PERF_RENDERER=hardware PERF_FRAMES=30 PERF_OUT=native-performance/gx-hardware.json node tests/browser-performance.mjs
PERF_RENDERER=software node native/tests/compare-core-performance.mjs
```

The harness warms up for 12 frames, then requests frames without display pacing.
GX runs must match both palettes and keep changing during measurement. JSON
reports contain elapsed time, uncapped throughput, median/p95 frame time, startup
time, and audio/video message counts. The paired script downloads the
hash-verified release pinned by `native/core-release.json` to a separate temporary
directory and compares it with the candidate for 120 compute frames, three times
each, alternating order. Both use the same frontend and original compute probe.
It writes raw runs and `native-performance/comparison.json`; it imposes no noisy
automatic speed threshold.

Useful overrides are `SMOKE_BROWSER=firefox`, `PERF_CORE_DIR=/path/to/core`,
`PERF_DIST=/path/to/dist`, `PERF_FRAMES=120`, and `PERF_GX_LAYERS=8`.
`PERF_RENDERER=software` forces the CPU rasterizer; `hardware` requests the native
WebGL2 backend, which can fall back when required browser capabilities are
missing. The report records the request, so use the GPU smoke assertion to prove
hardware rendering on the tested browser. These measurements include native
execution, native GPU rendering/readback where selected, and worker message
delivery. They exclude frontend presentation, audio playback, and display pacing.
Synthetic results do not establish commercial-game compatibility or speed; test
the actual game and target browser before choosing a release.
