import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBootProbe } from '../native/tests/boot-probe.mjs';
import { createWadBootProbe } from '../native/tests/wad-boot-probe.mjs';
import { createGxBootProbe } from '../native/tests/gx-boot-probe.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browserName = process.env.SMOKE_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit', 'firefox'].includes(browserName), 'Unsupported smoke-test browser');
const expectGPU = process.env.SMOKE_EXPECT_GPU === '1';
const disableWorkerGPU = process.env.SMOKE_DISABLE_WORKER_GPU === '1';
assert.ok(!(expectGPU && disableWorkerGPU), 'GPU-required and forced-fallback checks are separate runs');
assert.ok(!(process.env.SMOKE_URL && (expectGPU || disableWorkerGPU)), 'GPU instrumentation requires the local smoke server');
assert.ok(!(expectGPU || disableWorkerGPU) || process.env.EXPECT_CORE_READY === '1', 'GPU checks require real native core boot tests');
const root = path.resolve('dist');
let server;
let url = process.env.SMOKE_URL;
if (!url) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/WiiClipse/')) { response.writeHead(404).end(); return; }
    const relative = decodeURIComponent(pathname.slice('/WiiClipse/'.length)) || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      let content = await fs.readFile(file);
      if ((expectGPU || disableWorkerGPU) && relative === 'src/dolphin-worker.js') {
        // Instrument the actual worker before it loads Emscripten. Main-thread
        // WebGL is unaffected, so this exercises native renderer negotiation.
        const setup = disableWorkerGPU ? 'globalThis.OffscreenCanvas = undefined;' : `
          const originalGetContext = OffscreenCanvas.prototype.getContext;
          const observedContexts = new WeakSet();
          OffscreenCanvas.prototype.getContext = function (...args) {
            const gl = originalGetContext.apply(this, args);
            if (args[0] === 'webgl2' && gl && !observedContexts.has(gl)) {
              observedContexts.add(gl);
              self.postMessage({ type: 'smoke-native-gl', state: 'created' });
              let announced = false;
              for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
                const originalDraw = gl[method];
                gl[method] = function (...drawArgs) {
                  const result = originalDraw.apply(this, drawArgs);
                  if (!announced) {
                    announced = true;
                    self.postMessage({ type: 'smoke-native-gl', state: 'drawn' });
                  }
                  return result;
                };
              }
            }
            return gl;
          };
        `;
        content = Buffer.concat([Buffer.from(setup), Buffer.from('\n'), content]);
      }
      // Deliberately omit COOP/COEP: this reproduces GitHub Pages hosting.
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(content);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/WiiClipse/`;
}

let browser;
let page;
const errors = [];
const browserLogs = [];
try {
  browser = await playwright[browserName].launch({
    headless: process.env.SMOKE_HEADED !== '1',
    ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    // Linux CI uses Xvfb + Mesa, because Firefox's headless backend can reject
    // WebGL2 before the app boots. Permit that explicit software GL driver;
    // all context creation, native boot and rendered-pixel checks still apply.
    ...(browserName === 'firefox' && process.platform === 'linux' && process.env.LIBGL_ALWAYS_SOFTWARE === '1' ? {
      firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.forbid-software': false },
    } : {}),
  });
  const context = await browser.newContext();
  const bootProbe = createBootProbe();
  if (process.env.EXPECT_CORE_READY === '1') {
    await context.addInitScript(({ samples, width, height }) => {
      const OriginalWorker = window.Worker;
      window.__bootProbe = { samples, width, height, frames: 0, matched: false, lastFrame: null };
      window.__bootProbeWorkerCount = 0;
      window.__bootProbeGraphics = { created: 0, drawn: 0 };
      window.__bootProbeProtocol = { sent: {}, received: {} };
      window.__bootProbeAudio = [];
      window.__bootProbeEvents = [];
      let bitmapReadback;
      const record = event => {
        window.__bootProbeEvents.push({ ...event, at: performance.now(), visibility: document.visibilityState });
        if (window.__bootProbeEvents.length > 40) window.__bootProbeEvents.shift();
      };
      document.addEventListener('click', event => {
        if (event.target.closest?.('#play')) record({ type: 'play-click', trusted: event.isTrusted,
          activation: navigator.userActivation?.isActive });
      }, true);
      document.addEventListener('visibilitychange', () => record({ type: 'visibility' }));
      const OriginalAudioContext = window.AudioContext;
      if (OriginalAudioContext) window.AudioContext = class extends OriginalAudioContext {
        constructor(...args) {
          super(...args);
          window.__bootProbeAudio.push(this);
          record({ type: 'audio-created', state: this.state });
          this.addEventListener('statechange', () => record({ type: 'audio-state', state: this.state }));
        }
        resume(...args) {
          record({ type: 'audio-resume', state: this.state });
          const result = super.resume(...args);
          result.then(() => record({ type: 'audio-resumed', state: this.state }),
            error => record({ type: 'audio-resume-error', message: String(error) }));
          return result;
        }
      };
      const originalDrawArrays = WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.drawArrays = function (...args) {
        const output = originalDrawArrays.apply(this, args);
        const result = window.__bootProbe;
        if (this.canvas.id === 'screen' && result?.lastFrame) {
          // Read immediately after drawing: the app deliberately does not keep
          // the canvas drawing buffer alive after the browser presents it.
          const { width, height } = result;
          result.presentedColors = result.samples.map(({ x, y }) => {
            const color = new Uint8Array(4);
            this.readPixels(Math.floor((x + 0.5) * this.canvas.width / width),
              this.canvas.height - 1 - Math.floor((y + 0.5) * this.canvas.height / height),
              1, 1, this.RGBA, this.UNSIGNED_BYTE, color);
            return [...color.subarray(0, 3)];
          });
          result.presentedMatched ||= result.samples.every((sample, i) => ['r', 'g', 'b'].every((channel, c) =>
            Math.abs(result.presentedColors[i][c] - sample[channel]) <= 35));
        }
        return output;
      };
      window.Worker = class extends OriginalWorker {
        postMessage(message, ...args) {
          const counts = window.__bootProbeProtocol.sent;
          counts[message?.type] = (counts[message?.type] || 0) + 1;
          return super.postMessage(message, ...args);
        }
        constructor(...args) {
          super(...args);
          window.__bootProbeWorkerCount++;
          this.addEventListener('message', ({ data }) => {
            const counts = window.__bootProbeProtocol.received;
            counts[data?.type] = (counts[data?.type] || 0) + 1;
            if (data?.type === 'smoke-native-gl') {
              window.__bootProbeGraphics[data.state]++;
              return;
            }
            if (data?.type !== 'video' || (!data.buffer && !data.bitmap)) return;
            const result = window.__bootProbe;
            let bytes;
            let pitch = data.pitch;
            if (data.bitmap) {
              // Test-only readback before the app uploads and closes the bitmap.
              // Production presentation uploads it directly into WebGL.
              bitmapReadback ||= new OffscreenCanvas(data.width, data.height);
              if (bitmapReadback.width !== data.width) bitmapReadback.width = data.width;
              if (bitmapReadback.height !== data.height) bitmapReadback.height = data.height;
              const ctx = bitmapReadback.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(data.bitmap, 0, data.bitmap.height - data.height, data.width, data.height,
                0, 0, data.width, data.height);
              bytes = ctx.getImageData(0, 0, data.width, data.height).data;
              pitch = data.width * 4;
              result.bitmapFrames = (result.bitmapFrames || 0) + 1;
            } else bytes = new Uint8Array(data.buffer);
            const colors = result.samples.map(({ x, y }) => {
              const px = Math.floor((x + 0.5) * data.width / result.width);
              const py = Math.floor((y + 0.5) * data.height / result.height);
              const offset = py * pitch + px * 4;
              const rgba = !!data.bitmap || data.pixelFormat === 'RGBA8888';
              return [bytes[offset + (rgba ? 0 : 2)], bytes[offset + 1], bytes[offset + (rgba ? 2 : 0)]];
            });
            result.frames++;
            result.lastFrame = { width: data.width, height: data.height, colors };
            const matches = expected => expected.every((sample, index) =>
              sample.x < result.width && sample.y < result.height &&
              ['r', 'g', 'b'].every((channel, c) => Math.abs(colors[index][c] - sample[channel]) <= 35));
            const primary = matches(result.samples);
            const alternate = result.alternateSamples && matches(result.alternateSamples);
            result.matched ||= primary;
            result.alternateMatched ||= alternate;
            const palette = primary ? 0 : alternate ? 1 : undefined;
            if (palette !== undefined) {
              if (result.previousPalette !== undefined && palette !== result.previousPalette) result.paletteTransitions = (result.paletteTransitions || 0) + 1;
              result.previousPalette = palette;
            }
          });
        }
      };
    }, { samples: bootProbe.samples, width: bootProbe.width, height: bootProbe.height });
  }
  page = await context.newPage();
  if (process.env.SMOKE_DEBUG) page.on('console', message => console.log(message.text()));
  page.on('pageerror', error => { errors.push(error.message); if (process.env.SMOKE_DEBUG) console.error(error); });
  page.on('console', message => {
    browserLogs.push(`${message.type()}: ${message.text()}`);
    if (browserLogs.length > 100) browserLogs.shift();
  });
  await page.goto(url);
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 15000 });
  if (process.env.SMOKE_DEBUG) console.log('Opened app', url);
  await page.waitForFunction(() => {
    const state = document.querySelector('#coreState')?.textContent || '';
    return /not built|ready|unavailable/i.test(state);
  }, null, { timeout: process.env.EXPECT_CORE_READY === '1' ? 120000 : 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 });
  // One first-visit reload should have made the page isolated before app startup.
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'Pages startup must enable cross-origin isolation');
  assert.equal(await page.evaluate(() => typeof SharedArrayBuffer), 'function');
  const coreState = await page.locator('#coreState').textContent();
  if (process.env.SMOKE_DEBUG) console.log('Core status', coreState);
  assert.match(coreState, /not built|ready/i, 'Worker must either initialize or report the known missing core, not an unrelated startup failure');
  if (process.env.EXPECT_CORE_READY === '1') {
    assert.match(coreState, /^Core ready/, 'Native build must initialize the real Dolphin module');
  }
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#gameFile').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('not a game') });
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#gameFile').setInputFiles({ name: 'homebrew.dol', mimeType: 'application/octet-stream', buffer: Buffer.from('selection test only; not an executable') });
  assert.equal(await page.locator('#gameName').textContent(), 'homebrew.dol');
  if (!/ready/i.test(coreState)) assert.equal(await page.locator('#play').isDisabled(), true, 'Missing core must never enable Play');
  // This only checks WAD selection and classification; the fixture is never booted.
  assert.ok((await page.locator('#gameFile').getAttribute('accept')).split(',').includes('.wad'));
  await page.locator('#gameFile').setInputFiles({ name: 'channel.WAD', mimeType: 'application/octet-stream', buffer: Buffer.from('selection test only; not a Wii channel') });
  assert.equal(await page.locator('#gameName').textContent(), 'channel.WAD');
  assert.match(await page.locator('#gameMeta').textContent(), /Wii channel \(WAD\)/);
  if (!/ready/i.test(coreState)) assert.equal(await page.locator('#play').isDisabled(), true, 'Selecting WAD must not enable Play without a core');
  if (process.env.EXPECT_CORE_READY === '1') {
    await page.locator('#gameFile').setInputFiles({ name: bootProbe.fileName, mimeType: 'application/octet-stream', buffer: bootProbe.bytes });
    await page.locator('#play').click();
    if (process.env.SMOKE_DEBUG) console.log('Clicked DOL Play');
    await page.waitForFunction(() => window.__bootProbe?.matched === true && window.__bootProbe?.presentedMatched === true, null, { timeout: 120000 });
    console.log(JSON.stringify({ nativeHomebrewBoot: await page.evaluate(() => window.__bootProbe) }));
  }
  await page.reload();
  await page.waitForFunction(() => /not built|ready|unavailable/i.test(document.querySelector('#coreState')?.textContent || ''), null,
    { timeout: process.env.EXPECT_CORE_READY === '1' ? 120000 : 30000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  if (process.env.EXPECT_CORE_READY === '1') {
    assert.match(await page.locator('#coreState').textContent(), /^Core ready/, 'Native core must initialize after reload');
    const wadProbe = createWadBootProbe();
    await page.evaluate(({ samples, width, height }) => {
      window.__bootProbe = { samples, width, height, frames: 0, matched: false, lastFrame: null };
    }, { samples: wadProbe.samples, width: wadProbe.width, height: wadProbe.height });
    await page.locator('#gameFile').setInputFiles({ name: wadProbe.fileName, mimeType: 'application/octet-stream', buffer: wadProbe.bytes });
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__bootProbe?.matched === true && window.__bootProbe?.presentedMatched === true, null, { timeout: 120000 });
    console.log(JSON.stringify({ nativeWadBoot: await page.evaluate(() => window.__bootProbe), titleId: wadProbe.titleId }));

    // Replace the running Wii channel with the original GameCube DOL in the
    // same page and worker. Reversed WAD colors cannot satisfy this new match.
    const replacementStart = await page.evaluate(({ samples, width, height }) => {
      window.__bootProbe = { samples, width, height, frames: 0, matched: false, lastFrame: null };
      return { timeOrigin: performance.timeOrigin, workers: window.__bootProbeWorkerCount };
    }, { samples: bootProbe.samples, width: bootProbe.width, height: bootProbe.height });
    await page.locator('#gameFile').setInputFiles({ name: bootProbe.fileName, mimeType: 'application/octet-stream', buffer: bootProbe.bytes });
    assert.equal(await page.locator('#play').isDisabled(), false, 'Selecting a different title must allow replacing the running WAD');
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__bootProbe?.matched === true && window.__bootProbe?.presentedMatched === true, null, { timeout: 120000 });
    assert.deepEqual(await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, workers: window.__bootProbeWorkerCount })),
      replacementStart, 'Title replacement must keep the same page and native worker');
    console.log(JSON.stringify({ nativeTitleReplacement: 'WAD to DOL', nativeHomebrewBoot: await page.evaluate(() => window.__bootProbe) }));

    const gxProbe = createGxBootProbe({ layers: 2 });
    const graphicsBeforeGx = await page.evaluate(() => window.__bootProbeGraphics);
    await page.evaluate(({ samples, alternateSamples, width, height }) => {
      window.__bootProbe = { samples, alternateSamples, width, height, frames: 0, matched: false, lastFrame: null };
    }, { samples: gxProbe.samples, alternateSamples: gxProbe.alternateSamples, width: gxProbe.width, height: gxProbe.height });
    await page.locator('#gameFile').setInputFiles({ name: gxProbe.fileName, mimeType: 'application/octet-stream', buffer: gxProbe.bytes });
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__bootProbe?.matched && window.__bootProbe?.alternateMatched &&
      window.__bootProbe?.presentedMatched && window.__bootProbe?.paletteTransitions >= 3, null, { timeout: 120000 });
    console.log(JSON.stringify({ nativeGxBoot: await page.evaluate(() => window.__bootProbe), graphics: await page.evaluate(() => window.__bootProbeGraphics) }));
    const graphicsBeforeReplacement = await page.evaluate(() => window.__bootProbeGraphics);
    if (expectGPU) assert.ok(graphicsBeforeReplacement.created > graphicsBeforeGx.created && graphicsBeforeReplacement.drawn > graphicsBeforeGx.drawn,
      'The GX probe itself must create and draw through native-worker WebGL');

    await page.evaluate(({ samples, width, height }) => {
      window.__bootProbe = { samples, width, height, frames: 0, matched: false, lastFrame: null };
    }, { samples: bootProbe.samples, width: bootProbe.width, height: bootProbe.height });
    await page.locator('#gameFile').setInputFiles({ name: bootProbe.fileName, mimeType: 'application/octet-stream', buffer: bootProbe.bytes });
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__bootProbe?.matched && window.__bootProbe?.presentedMatched, null, { timeout: 120000 });
    assert.deepEqual(await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, workers: window.__bootProbeWorkerCount })),
      replacementStart, 'GX replacement must keep the same page and native worker');
    const graphics = await page.evaluate(() => window.__bootProbeGraphics);
    if (expectGPU) {
      assert.ok(graphicsBeforeReplacement.drawn >= 1, 'The GX probe must execute actual native-worker WebGL draws');
      assert.ok(graphics.created > graphicsBeforeReplacement.created && graphics.drawn > graphicsBeforeReplacement.drawn,
        'Replacing the title must initialize and draw through a fresh native graphics context');
    }
    if (disableWorkerGPU) assert.deepEqual(graphics, { created: 0, drawn: 0 }, 'Software fallback must boot all probes without a worker graphics context');
    console.log(JSON.stringify({ nativeTitleReplacement: 'GX to DOL', graphics, forcedSoftwareFallback: disableWorkerGPU }));
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (server) {
    // Stop the origin to test real network failure. Playwright's WebKit offline
    // emulation incorrectly rejects service-worker responses (issue #42775).
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    server = null;
  } else {
    assert.equal(browserName, 'chromium', 'Remote offline checks currently require Chromium');
    await context.setOffline(true);
  }
  await page.reload();
  await page.locator('#chooseGame').waitFor();
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.deepEqual(errors, [], 'App startup must not throw uncaught errors');
  console.log(JSON.stringify({ browser: browserName, url, coreState, checks: ['first visit', 'isolation', 'SharedArrayBuffer', 'DOL and WAD file selection (no game boot)', 'missing-core guard', 'reload', 'offline shell', 'no uncaught errors'] }));
} catch (error) {
  console.error(JSON.stringify({ browser: browserName, url, errors, browserLogs,
    coreState: await page?.locator('#coreState').textContent({ timeout: 1000 }).catch(() => null),
    status: await page?.locator('#status').textContent({ timeout: 1000 }).catch(() => null),
    nativeHomebrewBoot: await page?.evaluate(() => window.__bootProbe).catch(() => null),
    lifecycle: await page?.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus(),
      playDisabled: document.querySelector('#play')?.disabled, events: window.__bootProbeEvents,
      protocol: window.__bootProbeProtocol,
      audio: window.__bootProbeAudio?.map(audio => ({ state: audio.state, currentTime: audio.currentTime, sampleRate: audio.sampleRate })),
    })).catch(() => null),
  }));
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
