// Real compiled-core integration: no mocked compiler manager or native registry.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createComputeProbe } from './boot-probe.mjs';
import { createFloatingPointProbe } from './fp-boot-probe.mjs';
import { compilerProbeSource } from '../../tests/local-game-performance.mjs';

const root = path.resolve(process.env.COMPILER_DIST || 'dist');
const coreRoot = path.resolve(process.env.COMPILER_CORE_DIR || path.join(root, 'core'));
const output = path.resolve(process.env.COMPILER_OUT || 'native-performance/compiler-browser.json');
const timeoutMs = Number(process.env.COMPILER_TIMEOUT_MS || 120000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
const probeKind = process.env.COMPILER_PROBE || 'integer';
assert.ok(['integer', 'fp'].includes(probeKind), 'COMPILER_PROBE must be integer or fp');
const promotionFrames = Number(process.env.COMPILER_PROMOTION_FRAMES || 180);
assert.ok(Number.isInteger(promotionFrames) && promotionFrames > 0 && promotionFrames <= 180);
const report = { status: 'starting', coreRoot, probeKind, phases: [], browserErrors: [] };
report.wasmSha256 = createHash('sha256').update(await fs.readFile(path.join(coreRoot, 'dolphin-core.wasm'))).digest('hex');
// The compute probe draws an immutable XFB. Request every VI presentation so
// each phase verifies newly delivered pixels, not a previously cached image.
const fixtureConfigSource = `
self.addEventListener('message', ({ data = {} }) => {
  if (data.type !== 'compiler-test-config') return;
  enqueue(() => {
    try {
      const directory = '/dolphin/save/User/GameSettings';
      if (!/^wiiclipse-(compute|fp)-probe[.]dol$/.test(data.fileName)) throw new Error('Unknown compiler fixture');
      adapter.module.FS.mkdirTree(directory);
      adapter.module.FS.writeFile(directory + '/ID-' + data.fileName.slice(0, -4) + '.ini',
        '[Video_Hacks]\\nSkipDuplicateXFBs = False\\n');
      send('compiler-test-configured', { ok: true });
    } catch (error) { send('compiler-test-configured', { error: error.message }); }
  });
});
`;
const server = http.createServer(async (request, response) => {
  try {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    const base = relative.startsWith('core/') ? coreRoot : root;
    const file = path.resolve(base, relative.startsWith('core/') ? relative.slice(5) : relative);
    if (!file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
    let body = relative === 'compiler-test.html' ? '<!doctype html><title>Compiler integration</title>' : await fs.readFile(file);
    if (relative === 'src/dolphin-worker.js') body = body.toString('utf8') + '\n' + compilerProbeSource + fixtureConfigSource;
    response.writeHead(200, {
      'Content-Type': ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache',
    }).end(body);
  } catch { response.writeHead(404).end(); }
});
let browser;
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const browserName = process.env.SMOKE_BROWSER || 'chromium';
  assert.ok(playwright[browserName]?.launch, `Unsupported browser ${browserName}`);
  browser = await playwright[browserName].launch({ headless: true,
    ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  report.browser = browserName;
  const page = await browser.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  const probe = probeKind === 'fp' ? createFloatingPointProbe() : createComputeProbe();
  await page.goto(`http://127.0.0.1:${server.address().port}/compiler-test.html`);
  await page.exposeFunction('recordCompilerPhase', phase => {
    report.phases.push(phase);
    console.log(JSON.stringify(phase));
  });
  await page.evaluate(async ({ bytes, fileName, width, height, samples, timeoutMs, probeKind, promotionFrames }) => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    check(crossOriginIsolated, 'The actual shared-memory core requires isolation');
    const worker = new Worker('./src/dolphin-worker.js', { type: 'module' });
    const file = new File([new Uint8Array(bytes)], fileName);
    const logs = [];
    let pending, fatal, lastVideo, videoCount = 0;
    const fail = error => { fatal = error; pending?.reject(error); };
    worker.addEventListener('error', event => fail(new Error(event.message)));
    worker.addEventListener('messageerror', () => fail(new Error('Worker message decoding failed')));
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'video') {
        if (data.bitmap || !data.buffer) {
          data.bitmap?.close();
          fail(new Error('Integration fixture requested native pixel output'));
          return;
        }
        lastVideo = { ...data, bytes: new Uint8Array(data.buffer) }; videoCount++;
      }
      if (data.type === 'log') { logs.push(data.message); if (logs.length > 20) logs.shift(); }
      if (data.type === 'error' || data.type === 'unavailable') fail(new Error(data.message));
      if (pending?.type === data.type) pending.resolve(data);
    });
    const send = (message, type) => new Promise((resolve, reject) => {
      if (fatal) { reject(fatal); return; }
      check(!pending, 'Requests must remain serialized');
      const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for ${type}: ${logs.join('\n')}`)), timeoutMs);
      const waiter = { type,
        resolve(value) { clearTimeout(timer); pending = null; resolve(value); },
        reject(error) { clearTimeout(timer); pending = null; reject(error); },
      };
      pending = waiter; worker.postMessage(message);
    });
    const stats = async (mode = 'read') => {
      const reply = await send({ type: 'benchmark-compiler', mode }, 'benchmark-compiler-result');
      check(!reply.error, reply.error);
      const value = reply.snapshot;
      for (const field of ['compiled', 'compiledCalls', 'nativeFallbackCalls'])
        check(Number.isSafeInteger(value[field]) && value[field] >= 0, `Missing compiler statistic ${field}`);
      return value;
    };
    const frame = () => send({ type: 'frame' }, 'frame-done');
    const matched = () => lastVideo && samples.every(sample => {
      const x = Math.floor((sample.x + 0.5) * lastVideo.width / width);
      const y = Math.floor((sample.y + 0.5) * lastVideo.height / height);
      const offset = y * lastVideo.pitch + x * 4;
      const rgba = lastVideo.pixelFormat === 'RGBA8888';
      return [sample.r, sample.g, sample.b].every((value, channel) =>
        Math.abs(lastVideo.bytes[offset + (rgba ? channel : [2, 1, 0][channel])] - value) <= 35);
    });
    const hashFrame = async () => {
      check(matched(), 'Original DOL must display every expected pixel, including its arithmetic result');
      const digest = await crypto.subtle.digest('SHA-256', lastVideo.bytes);
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    };
    const promoted = async (phase, baseline) => {
      const started = performance.now();
      const beforeVideo = videoCount;
      let snapshot;
      for (let frames = 1; frames <= promotionFrames && performance.now() - started < timeoutMs; frames++) {
        await frame(); snapshot = await stats();
        if (snapshot.enabled && snapshot.compiled > 0 && snapshot.compiledCalls > baseline.compiledCalls &&
            videoCount > beforeVideo && matched()) {
          const result = { phase, frames, videoCount, snapshot, frameHash: await hashFrame() };
          await window.recordCompilerPhase(result); return result;
        }
      }
      throw new Error(`No real compiled execution in ${phase}: ${JSON.stringify(snapshot)}; ${logs.join('\n')}`);
    };
    const preparePromotion = async () => {
      let baseline = await stats('on');
      if (probeKind === 'fp') {
        // Startup paints the XFB with integer code. Wait for the FP loop's
        // verified result, then discard every bootstrap promotion. Every
        // steady-state probe block contains FP, so later compiledCalls prove
        // actual FP-block promotion rather than a startup-only success.
        const started = performance.now();
        for (let i = 0; i < 180 && !matched() && performance.now() - started < timeoutMs; i++) await frame();
        check(matched(), 'FP probe did not produce its checked arithmetic result');
        await stats('off');
        baseline = await stats('on');
        check(baseline.compiled === 0 && baseline.pending === 0, 'FP bootstrap promotions must be cleared');
        await window.recordCompilerPhase({ phase: 'fp-bootstrap-cleared', snapshot: baseline,
          videoCount, frameHash: await hashFrame() });
      }
      return baseline;
    };
    try {
      await send({ type: 'init', renderer: 'software', video: 'pixels' }, 'ready');
      const configured = await send({ type: 'compiler-test-config', fileName }, 'compiler-test-configured');
      check(configured.ok, `Could not configure fixture presentation: ${configured.error}`);
      await send({ type: 'boot', file }, 'booted');
      const initial = await preparePromotion();
      const first = await promoted('promoted', initial);
      const disabled = await stats('off');
      check(disabled.enabled === false && disabled.compiled === 0 && disabled.pending === 0,
        `Disable must invalidate all native gates: ${JSON.stringify(disabled)}`);
      check(disabled.epoch !== first.snapshot.epoch, 'Disable must advance native identity epoch');
      const beforeVideo = videoCount;
      for (let i = 0; i < 3; i++) await frame();
      const off = await stats();
      check(off.compiledCalls === disabled.compiledCalls, 'Disabled execution must not call installed Wasm');
      check(off.nativeFallbackCalls > disabled.nativeFallbackCalls, 'Disabled execution must continue through native fallback');
      check(off.compiled === 0 && off.pending === 0 && videoCount > beforeVideo,
        `Disabled core must continue producing frames without promotions: ${JSON.stringify({ disabled, off, beforeVideo, videoCount })}`);
      const offHash = await hashFrame();
      check(offHash === first.frameHash, 'Disabling compiler changed the rendered frame');
      await window.recordCompilerPhase({ phase: 'disabled', snapshot: off, beforeVideo, videoCount, frameHash: offHash });
      const second = await promoted('re-enabled', await stats('on'));
      check(second.frameHash === first.frameHash, 'Re-enabling compiler changed the rendered frame');
      const unloaded = await send({ type: 'unload', requestId: 1 }, 'unloaded');
      check(unloaded.ok, `Unload failed: ${unloaded.message}`);
      const cleared = await stats();
      check(cleared.compiled === 0, 'Unload retained compiled native callbacks');
      lastVideo = null;
      await send({ type: 'boot', file }, 'booted');
      const rebooted = await promoted('rebooted', await preparePromotion());
      check(rebooted.frameHash === first.frameHash, 'Unload/reboot changed the rendered frame');
      const finalUnload = await send({ type: 'unload', requestId: 2 }, 'unloaded');
      check(finalUnload.ok, `Final unload failed: ${finalUnload.message}`);
    } finally { worker.terminate(); }
  }, { bytes: [...probe.bytes], fileName: probe.fileName, width: probe.width, height: probe.height,
    samples: probe.samples, timeoutMs, probeKind, promotionFrames });
  assert.deepEqual(report.browserErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
