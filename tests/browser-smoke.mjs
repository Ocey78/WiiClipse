import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBootProbe } from '../native/tests/boot-probe.mjs';
import { createWadBootProbe } from '../native/tests/wad-boot-probe.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browserName = process.env.SMOKE_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported smoke-test browser');
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
      const content = await fs.readFile(file);
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
  browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext();
  const bootProbe = createBootProbe();
  if (process.env.EXPECT_CORE_READY === '1') {
    await context.addInitScript(({ samples }) => {
      const OriginalWorker = window.Worker;
      window.__bootProbe = { samples, frames: 0, matched: false, lastFrame: null };
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data?.type !== 'video' || !data.buffer) return;
            const result = window.__bootProbe;
            const bytes = new Uint8Array(data.buffer);
            const colors = result.samples.map(({ x, y }) => {
              const offset = y * data.pitch + x * 4;
              const rgba = data.pixelFormat === 'RGBA8888';
              return [bytes[offset + (rgba ? 0 : 2)], bytes[offset + 1], bytes[offset + (rgba ? 2 : 0)]];
            });
            result.frames++;
            result.lastFrame = { width: data.width, height: data.height, colors };
            result.matched ||= result.samples.every((sample, index) =>
              sample.x < data.width && sample.y < data.height &&
              ['r', 'g', 'b'].every((channel, c) => Math.abs(colors[index][c] - sample[channel]) <= 35));
          });
        }
      };
    }, { samples: bootProbe.samples });
  }
  page = await context.newPage();
  if (process.env.SMOKE_DEBUG) page.on('console', message => console.log(message.text()));
  page.on('pageerror', error => { errors.push(error.message); if (process.env.SMOKE_DEBUG) console.error(error); });
  page.on('console', message => {
    browserLogs.push(`${message.type()}: ${message.text()}`);
    if (browserLogs.length > 100) browserLogs.shift();
  });
  await page.goto(url);
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
    await page.waitForFunction(() => window.__bootProbe?.matched === true, null, { timeout: 120000 });
    console.log(JSON.stringify({ nativeHomebrewBoot: await page.evaluate(() => window.__bootProbe) }));
  }
  await page.reload();
  await page.waitForFunction(() => /not built|ready|unavailable/i.test(document.querySelector('#coreState')?.textContent || ''), null,
    { timeout: process.env.EXPECT_CORE_READY === '1' ? 120000 : 30000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  if (process.env.EXPECT_CORE_READY === '1') {
    assert.match(await page.locator('#coreState').textContent(), /^Core ready/, 'Native core must initialize after reload');
    const wadProbe = createWadBootProbe();
    await page.evaluate(samples => {
      window.__bootProbe = { samples, frames: 0, matched: false, lastFrame: null };
    }, wadProbe.samples);
    await page.locator('#gameFile').setInputFiles({ name: wadProbe.fileName, mimeType: 'application/octet-stream', buffer: wadProbe.bytes });
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__bootProbe?.matched === true, null, { timeout: 120000 });
    console.log(JSON.stringify({ nativeWadBoot: await page.evaluate(() => window.__bootProbe), titleId: wadProbe.titleId }));
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
  }));
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
