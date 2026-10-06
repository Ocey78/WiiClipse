import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBootProbe, createComputeProbe } from '../native/tests/boot-probe.mjs';
import { createWadBootProbe } from '../native/tests/wad-boot-probe.mjs';
import { createGxBootProbe } from '../native/tests/gx-boot-probe.mjs';

const root = path.resolve(process.env.PERF_DIST || 'dist');
const coreRoot = process.env.PERF_CORE_DIR ? path.resolve(process.env.PERF_CORE_DIR) : path.join(root, 'core');
const frames = Number(process.env.PERF_FRAMES || 120);
assert.ok(Number.isInteger(frames) && frames >= 10 && frames <= 2000);
const renderer = process.env.PERF_RENDERER;
assert.ok(renderer === undefined || ['software', 'hardware'].includes(renderer), 'PERF_RENDERER must be software or hardware');
const gxLayers = Number(process.env.PERF_GX_LAYERS || 8);
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browserName = process.env.SMOKE_BROWSER || 'chromium';
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const relative = decodeURIComponent(pathname).replace(/^\//, '');
  const base = relative.startsWith('core/') ? coreRoot : root;
  const file = path.resolve(base, relative.startsWith('core/') ? relative.slice(5) : relative);
  if (!file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
  try {
    const body = relative === 'benchmark.html' ? '<!doctype html><title>WiiClipse performance</title>' : await fs.readFile(file);
    response.writeHead(200, {
      'Content-Type': ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache',
    }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const results = [];
try {
  browser = await playwright[browserName].launch({ headless: true,
    ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  for (const [name, probe] of [['idle', createBootProbe()], ['compute', createComputeProbe()], ['wad', createWadBootProbe()],
    ['gx', createGxBootProbe({ layers: gxLayers })]]) {
    if (process.env.PERF_CASE && process.env.PERF_CASE !== name) continue;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/benchmark.html`);
    const result = await page.evaluate(async ({ name, bytes, width, height, samples, alternateSamples, frames, renderer }) => {
      const worker = new Worker('./src/dolphin-worker.js', { type: 'module' });
      let pending;
      const counters = { videoMessages: 0, videoBytes: 0, videoBitmaps: 0, audioMessages: 0, audioFrames: 0 };
      let matched = false;
      let alternateMatched = false;
      let paletteTransitions = 0;
      let previousPalette;
      let lastFrame;
      let bitmapReadback;
      let measuring = false;
      let finalMeasuredFrame = false;
      let lastFrameMatched = false;
      let finalBitmapChecked = false;
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'video') {
          counters.videoMessages++;
          counters.videoBytes += data.buffer?.byteLength || 0;
          if (data.bitmap) counters.videoBitmaps++;
          // Read actual bitmap pixels during warmup and at the final measured
          // frame only. Intermediate measurement frames retain zero CPU readback.
          const check = data.bitmap ? (!measuring || finalMeasuredFrame) : (!matched || alternateSamples);
          try { if (check) {
            let pixels;
            let pitch = data.pitch;
            if (data.bitmap) {
              if (measuring && finalMeasuredFrame) finalBitmapChecked = true;
              bitmapReadback ||= new OffscreenCanvas(data.width, data.height);
              if (bitmapReadback.width !== data.width) bitmapReadback.width = data.width;
              if (bitmapReadback.height !== data.height) bitmapReadback.height = data.height;
              const ctx = bitmapReadback.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(data.bitmap, 0, data.bitmap.height - data.height, data.width, data.height,
                0, 0, data.width, data.height);
              pixels = ctx.getImageData(0, 0, data.width, data.height).data;
              pitch = data.width * 4;
            } else pixels = new Uint8Array(data.buffer);
            const rgba = !!data.bitmap || data.pixelFormat === 'RGBA8888';
            const colors = samples.map(({ x, y }) => {
              // OGL presents into its output surface (e.g. 640x528), while the
              // software backend returns the original XFB (e.g. 640x480).
              const px = Math.floor((x + 0.5) * data.width / width);
              const py = Math.floor((y + 0.5) * data.height / height);
              const i = py * pitch + px * 4;
              return [pixels[i + (rgba ? 0 : 2)], pixels[i + 1], pixels[i + (rgba ? 2 : 0)]];
            });
            lastFrame = { width: data.width, height: data.height, probeWidth: width, probeHeight: height, colors };
            const matches = expected => expected.every((sample, index) => sample.x < width && sample.y < height &&
              ['r', 'g', 'b'].every((c, i) => Math.abs(colors[index][i] - sample[c]) <= 35));
            const primary = matches(samples);
            const alternate = alternateSamples && matches(alternateSamples);
            lastFrameMatched = primary || !!alternate;
            matched ||= primary;
            alternateMatched ||= alternate;
            const palette = primary ? 0 : alternate ? 1 : undefined;
            if (palette !== undefined) {
              if (previousPalette !== undefined && previousPalette !== palette) paletteTransitions++;
              previousPalette = palette;
            }
          } } catch (error) {
            pending?.reject(error);
          } finally { data.bitmap?.close(); }
        }
        if (data.type === 'audio') { counters.audioMessages++; counters.audioFrames += data.frames; }
        if (data.type === pending?.type) { const waiter = pending; pending = null; waiter.resolve(data); }
        else if (data.type === 'error' || data.type === 'unavailable') pending?.reject(new Error(data.message));
      });
      worker.addEventListener('error', event => pending?.reject(new Error(event.message)));
      const send = (message, type) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 120000);
        pending = { type, resolve: data => { clearTimeout(timer); resolve(data); }, reject: error => { clearTimeout(timer); reject(error); } };
        worker.postMessage(message);
      });
      try {
        const start = performance.now();
        await send({ type: 'init', renderer }, 'ready');
        const initMs = performance.now() - start;
        const bootStart = performance.now();
        await send({ type: 'boot', file: new File([new Uint8Array(bytes)], name) }, 'booted');
        const bootMs = performance.now() - bootStart;
        for (let i = 0; i < 12; i++) await send({ type: 'frame' }, 'frame-done');
        if (!matched) throw new Error(`Original probe did not render: ${JSON.stringify(lastFrame)}`);
        if (alternateSamples && !alternateMatched) throw new Error(`GX probe did not render both palettes: ${JSON.stringify(lastFrame)}`);
        const warmupPaletteTransitions = paletteTransitions;
        if (alternateSamples && warmupPaletteTransitions < 2) throw new Error('GX warmup must prove sustained alternating draws');
        for (const key of Object.keys(counters)) counters[key] = 0;
        paletteTransitions = 0;
        measuring = true;
        const durations = [];
        const runStart = performance.now();
        for (let i = 0; i < frames; i++) {
          finalMeasuredFrame = i === frames - 1;
          const frameStart = performance.now();
          await send({ type: 'frame' }, 'frame-done');
          durations.push(performance.now() - frameStart);
        }
        const elapsedMs = performance.now() - runStart;
        if (counters.videoBitmaps && (!finalBitmapChecked || !lastFrameMatched)) throw new Error(`Final GPU bitmap did not render: ${JSON.stringify(lastFrame)}`);
        if (alternateSamples && !counters.videoBitmaps && paletteTransitions < 2) throw new Error(`GX draws stopped changing: ${paletteTransitions} palette transitions in ${frames} frames`);
        durations.sort((a, b) => a - b);
        return { initMs, bootMs, frames, elapsedMs, uncappedFps: frames * 1000 / elapsedMs,
          medianFrameMs: durations[Math.floor(frames * 0.5)], p95FrameMs: durations[Math.floor(frames * 0.95)],
          ...counters, matched, lastFrame, ...(alternateSamples ? { alternateMatched, warmupPaletteTransitions,
            ...(!counters.videoBitmaps ? { paletteTransitions } : {}) } : {}),
          ...(counters.videoBitmaps ? { finalBitmapValidated: lastFrameMatched } : {}) };
      } finally { worker.terminate(); }
    }, { name: probe.fileName, bytes: [...probe.bytes], width: probe.width, height: probe.height,
      samples: probe.samples, alternateSamples: probe.alternateSamples, frames, renderer });
    results.push({ scenario: name, ...(probe.trianglesPerFrame ? { trianglesPerFrame: probe.trianglesPerFrame } : {}), ...result });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  const report = { browser: browserName, root, coreRoot, frames, requestedRenderer: renderer || 'default', measuredAt: new Date().toISOString(),
    scope: 'Uncapped real Dolphin worker execution and message delivery; bitmap runs include completion/readback of the last GPU image. Excludes frontend presentation, audio playback, and display pacing. Original probes do not establish commercial-game speed.', results };
  if (process.env.PERF_OUT) await fs.writeFile(process.env.PERF_OUT, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
