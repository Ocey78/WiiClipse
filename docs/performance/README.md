# Optimization results — October 6, 2026

Selected core: [`core-4f9c00a21c04-37499430947`](https://github.com/Ocey78/WiiClipse/releases/tag/core-4f9c00a21c04-37499430947). Baseline: `core-d27e1c8f3860-37424761412`.

## Measured native execution

Each environment ran three trials per core in alternating order, using the same frontend and original compute-heavy PowerPC DOL. Each trial warmed up for 12 emulated frames, verified the expected video, then timed 120 frames. The workload performs arithmetic and memory operations continuously so Dolphin cannot optimize away an idle loop.

| Environment | Baseline median | Optimized median | Throughput increase |
| --- | ---: | ---: | ---: |
| GitHub Linux / Chromium | 10,629.67 ms | 9,890.93 ms | 7.47% |
| Local Windows / Chrome | 7,981.14 ms | 7,563.66 ms | 5.52% |

Every optimized trial was faster than every baseline trial in its environment. These are measurements of uncapped native execution and worker communication, excluding display pacing, WebGL presentation, and audio playback. They do not establish commercial-game FPS or performance on an iPhone.

Both cores produced exactly 64,128 audio sample frames per trial. Batching reduced audio messages from **668 to 120 (82.0%)** without discarding samples. The optimized host also reports Dolphin's actual audio rate instead of assuming 48 kHz.

Raw evidence: [CI comparison](ci-comparison.json), [local comparison](local-comparison.json), and [native build/test run](https://github.com/Ocey78/WiiClipse/actions/runs/37499430947).

## Browser work removed

- One AudioWorklet and a fixed 16 KiB PCM queue replace per-chunk playback objects. A 5,000-chunk allocation fixture previously required 5,000 AudioBuffers and 5,000 source nodes; the primary path now creates neither. Browser signal tests separately verify stereo order, resampling, pause/resume, and fallback playback.
- Video texture storage persists across frames. Uploads use `texSubImage2D`; dimensions, viewport and canvas layout are updated when they change. Pixel-aligned padded rows use WebGL2 row stride instead of allocating packed copies.
- The native host sends RGBA directly, eliminating its full-frame color-swizzle buffer. The browser retains compatibility with older XRGB cores.
- Frames are paced by the console clock and requested on completion, with one frame outstanding. Slow emulation no longer waits for another display refresh; fast emulation is capped independently of the display's refresh rate. PAL rates and hidden-page pauses are covered.
- Unchanged controller state creates no repeated worker messages or native input calls. Core asset URLs share a content digest to avoid mixing old cached binaries with a new loader.

The renderer's padded-row microbenchmark measured 80.8 ms before and 51.4 ms after for 120 uploads at 640×480, eliminating 147,456,000 temporary bytes. Tight-row timings were inconclusive, and the normal native frame path uses tight rows. This result must not be presented as a general game-speed increase.

## Verification and limits

The suite contains 89 passing Node tests, compiled native host contracts, browser pixel checks, real AudioWorklet and fallback signal checks, and real scheduler tests. Browser smoke checks execute original GameCube DOL and Wii WAD programs, verify their distinct colors, and replace the running WAD with the DOL without recreating the page or worker. Pages requires Chromium and WebKit checks before publishing.

The CPU remains a Cached Interpreter and graphics remain software-rendered. A GPU emulation backend and PowerPC JIT were not added. Commercial titles, physical iOS devices, and long-session save/controller behavior remain outside the verification performed here.
