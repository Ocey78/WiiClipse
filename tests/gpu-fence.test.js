import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { waitForGpuFence, summarizeThroughput } from './local-game-performance.mjs';

function fakeFence(statuses, { lost = false, noFence = false } = {}) {
  const calls = []; let elapsed = 0;
  const sync = {};
  const gl = { SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5,
    isContextLost: () => lost,
    fenceSync: (...args) => { calls.push(['fence', ...args]); return noFence ? null : sync; },
    flush: () => calls.push(['flush']),
    clientWaitSync: (...args) => { calls.push(['wait', ...args]); return statuses.shift() ?? 4; },
    deleteSync: value => calls.push(['delete', value]) };
  const timing = { now: () => elapsed, yieldToEventLoop: async () => { calls.push(['yield']); elapsed += 2; } };
  return { gl, timing, calls, sync };
}

test('GPU fence flushes, yields before polling, and measures the completed wait', async () => {
  for (const signaled of [2, 3]) {
    const { gl, timing, calls, sync } = fakeFence([4, signaled]);
    assert.equal(await waitForGpuFence(gl, 10, timing), 4);
    assert.deepEqual(calls, [['fence', 1, 0], ['flush'], ['yield'], ['wait', sync, 0, 0],
      ['yield'], ['wait', sync, 0, 0], ['delete', sync]]);
  }
});

test('GPU fence timeout and failed waits reject and always release the sync', async () => {
  for (const [statuses, pattern] of [[[4, 4, 4], /timed out/i], [[5], /failed/i], [[99], /unexpected/i]]) {
    const { gl, timing, calls, sync } = fakeFence(statuses);
    await assert.rejects(waitForGpuFence(gl, 5, timing), pattern);
    assert.deepEqual(calls.at(-1), ['delete', sync]);
  }
  const lost = fakeFence([2]);
  lost.timing.yieldToEventLoop = async () => { lost.gl.isContextLost = () => true; };
  await assert.rejects(waitForGpuFence(lost.gl, 5, lost.timing), /context.*lost/i);
  assert.deepEqual(lost.calls.at(-1), ['delete', lost.sync]);
  const missing = fakeFence([], { noFence: true });
  await assert.rejects(waitForGpuFence(missing.gl, 5, missing.timing), /create.*fence/i);
  assert.equal(missing.calls.some(call => call[0] === 'delete'), false);
});

test('incomplete GPU measurements never report completed throughput', () => {
  const metrics = { frames: 120, submissionMs: 1000, gpuCompletionMs: 200, gpuCompletedWallMs: 1500,
    videoMessages: 60, emulatedSeconds: 2 };
  for (const gpuCompletionFinalized of [false, undefined]) {
    const result = summarizeThroughput({ ...metrics, gpuCompletionFinalized });
    assert.equal(result.submissionFps, 120);
    assert.equal(result.gpuCompletedWallFps, null);
    assert.equal(result.deliveredVideoMessagesPerSecond, null);
    assert.equal(result.emulationSpeedPercent, null);
  }
  assert.equal(summarizeThroughput({ ...metrics, gpuCompletionFinalized: true }).gpuCompletedWallFps, 80);
});

test('browser fence completes presentation of a worker GPU ImageBitmap', { skip: process.env.GPU_FENCE_BROWSER_TEST !== '1', timeout: 30000 }, async () => {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const browserName = process.env.SMOKE_BROWSER || 'chromium';
  const browser = await playwright[browserName].launch({ headless: true,
    ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas style="width:8px;height:8px" width="8" height="8"></canvas>');
    const rendererSource = await fs.readFile(new URL('../src/webgl-renderer.js', import.meta.url), 'utf8');
    const result = await page.evaluate(async ({ fenceSource, rendererSource }) => {
      const wait = (0, eval)(`(${fenceSource})`);
      const { WebGLRenderer } = await import(URL.createObjectURL(new Blob([rendererSource], { type: 'text/javascript' })));
      const presenter = new WebGLRenderer(document.querySelector('canvas'));
      const worker = new Worker(URL.createObjectURL(new Blob([`
        const canvas = new OffscreenCanvas(8, 8);
        const gl = canvas.getContext('webgl2');
        gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        const bitmap = canvas.transferToImageBitmap(); postMessage(bitmap, [bitmap]);
      `], { type: 'text/javascript' })));
      try {
        const bitmap = await new Promise((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = reject; });
        presenter.presentImageBitmap({ bitmap, width: 8, height: 8 });
        const elapsedMs = await wait(presenter.gl, 5000);
        // Read the retained imported texture; the default framebuffer may be
        // discarded when the asynchronous fence yields to the browser.
        const gl = presenter.gl; const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, presenter.texture, 0);
        const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return { elapsedMs, pixel: [...pixel], error: gl.getError() };
      } finally { worker.terminate(); }
    }, { fenceSource: waitForGpuFence.toString(), rendererSource });
    assert.ok(result.elapsedMs >= 0);
    assert.deepEqual(result.pixel, [0, 255, 0, 255]);
    assert.equal(result.error, 0);
  } finally { await browser.close(); }
});
