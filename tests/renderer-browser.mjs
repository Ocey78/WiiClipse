import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Real WebGL pixel regression check; optional same-browser before/after throughput sample.
// RENDERER_BASELINE points to a saved pre-change renderer module. Timings are informational.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const modules = new Map([
  ['/renderer.js', await fs.readFile(new URL('../src/webgl-renderer.js', import.meta.url))],
]);
if (process.env.RENDERER_BASELINE) modules.set('/baseline.js', await fs.readFile(process.env.RENDERER_BASELINE));
const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Renderer check</title>');
  } else if (modules.has(request.url)) {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(modules.get(request.url));
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const correctness = await page.evaluate(async () => {
    const { WebGLRenderer } = await import('/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:3px;height:2px';
    document.body.append(canvas);
    const renderer = new WebGLRenderer(canvas);
    const gl = renderer.gl;
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0]];
    const expected = [0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255,
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]; // readPixels is bottom-up
    const checks = [];
    for (const [pitch, pixelFormat] of [[16, undefined], [12, undefined], [13, undefined], [16, 'RGBA8888'], [12, undefined]]) {
      const bytes = new Uint8Array(pitch * 2).fill(119);
      colors.forEach(([r, g, b], i) => bytes.set(pixelFormat ? [r, g, b, 0] : [b, g, r, 0], Math.floor(i / 3) * pitch + (i % 3) * 4));
      renderer.presentXRGB8888({ buffer: bytes.buffer, width: 3, height: 2, pitch, pixelFormat });
      const pixels = new Uint8Array(24);
      gl.readPixels(0, 0, 3, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (pixels.some((value, i) => value !== expected[i])) throw new Error(`Pixel mismatch for pitch=${pitch}, format=${pixelFormat}: ${pixels}`);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error during pixel check');
      checks.push({ pitch, pixelFormat: pixelFormat || 'legacy XRGB8888' });
    }
    canvas.style.cssText = 'width:7px;height:5px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const white = new Uint8Array(8).fill(255);
    renderer.presentXRGB8888({ buffer: white.buffer, width: 2, height: 1, pitch: 8 });
    if (canvas.width !== 7 || canvas.height !== 5) throw new Error('Observed CSS resize was missed');
    const resized = new Uint8Array(7 * 5 * 4);
    gl.readPixels(0, 0, 7, 5, gl.RGBA, gl.UNSIGNED_BYTE, resized);
    if (resized.some(value => value !== 255)) throw new Error('Viewport or texture-size change lost pixels');
    return { checks, resize: [canvas.width, canvas.height] };
  });
  assert.equal(correctness.checks.length, 5);
  const dprContext = await browser.newContext({ deviceScaleFactor: 3 });
  const dprPage = await dprContext.newPage();
  await dprPage.goto(`http://127.0.0.1:${server.address().port}/`);
  const dpr = await dprPage.evaluate(async () => {
    const { WebGLRenderer } = await import('/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:7px;height:5px';
    document.body.append(canvas);
    new WebGLRenderer(canvas);
    return { actual: devicePixelRatio, backing: [canvas.width, canvas.height] };
  });
  assert.deepEqual(dpr, { actual: 3, backing: [14, 10] });
  await dprContext.close();
  console.log(JSON.stringify({ rendererPixels: correctness, dpr }));

  if (process.env.RENDERER_BENCHMARK === '1') {
    const measurements = await page.evaluate(async ({ baseline }) => {
      const constructors = { current: (await import('/renderer.js')).WebGLRenderer };
      if (baseline) constructors.baseline = (await import('/baseline.js')).WebGLRenderer;
      const samples = [];
      for (const padding of [0, 64]) {
        for (let trial = 0; trial < 3; trial++) {
          const names = Object.keys(constructors);
          if (trial % 2) names.reverse();
          for (const name of names) {
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:640px;height:480px';
            document.body.append(canvas);
            let layoutReads = 0;
            for (const property of ['clientWidth', 'clientHeight']) {
              const get = Object.getOwnPropertyDescriptor(Element.prototype, property).get;
              Object.defineProperty(canvas, property, { get() { layoutReads++; return get.call(this); } });
            }
            const renderer = new constructors[name](canvas);
            const gl = renderer.gl;
            const pitch = 640 * 4 + padding;
            const pixels = new Uint8Array(pitch * 480).fill(127);
            const frame = { buffer: pixels.buffer, width: 640, height: 480, pitch };
            for (let i = 0; i < 20; i++) renderer.presentXRGB8888(frame);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            renderer.presentXRGB8888(frame);
            gl.finish();
            const calls = { texImage2D: 0, texSubImage2D: 0, viewport: 0, copiedBuffers: 0, copiedBytes: 0 };
            const seen = new WeakSet();
            for (const method of ['texImage2D', 'texSubImage2D', 'viewport']) {
              const original = gl[method].bind(gl);
              gl[method] = (...args) => {
                calls[method]++;
                if (method !== 'viewport') {
                  const upload = args.at(-1);
                  if (upload?.buffer && upload.buffer !== pixels.buffer && !seen.has(upload.buffer)) {
                    seen.add(upload.buffer);
                    calls.copiedBuffers++;
                    calls.copiedBytes += upload.byteLength;
                  }
                }
                return original(...args);
              };
            }
            layoutReads = 0;
            const frames = 120;
            const started = performance.now();
            for (let i = 0; i < frames; i++) renderer.presentXRGB8888(frame);
            gl.finish(); // include completion of the submitted GPU work
            const elapsedMs = performance.now() - started;
            if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error during benchmark');
            samples.push({ name, padding, trial, frames, elapsedMs, layoutReads, ...calls });
            renderer.resizeObserver?.disconnect();
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            canvas.remove();
          }
        }
      }
      return samples;
    }, { baseline: modules.has('/baseline.js') });
    console.log(JSON.stringify({ rendererBenchmark: measurements }));
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
