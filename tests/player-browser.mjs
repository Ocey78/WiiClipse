import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createBootProbe } from '../native/tests/boot-probe.mjs';

const root = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browserName = process.env.SMOKE_BROWSER || 'chromium';
const browser = await ({ chromium, webkit }[browserName]).launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.__player = { frames: 0, input: null };
  window.Worker = class extends NativeWorker {
    postMessage(message, ...args) {
      if (message.type === 'frame') window.__player.frames++;
      if (message.type === 'input') window.__player.input = message.snapshot;
      return super.postMessage(message, ...args);
    }
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => /^Core ready/.test(document.querySelector('#coreState').textContent), null, { timeout: 120000 });
  assert.match(await page.title(), /WiiClipse/);
  await page.locator('#gameFile').setInputFiles({ name: 'empty.iso', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  assert.equal(await page.locator('#play').isDisabled(), true);
  assert.match(await page.locator('#gameMeta').textContent(), /empty/);
  const probe = createBootProbe();
  await page.locator('#gameFile').setInputFiles({ name: probe.fileName, mimeType: 'application/octet-stream', buffer: probe.bytes });
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#sessionState').textContent === 'Playing');
  await page.keyboard.down('j');
  await page.waitForFunction(() => window.__player.input?.buttons.A === true);
  await page.keyboard.up('j');
  await page.waitForFunction(() => window.__player.input?.buttons.A === false);
  await page.locator('#showTouch').check();
  await page.locator('[data-button="A"]').hover();
  await page.mouse.down();
  await page.waitForFunction(() => window.__player.input?.buttons.A === true);
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await page.waitForFunction(() => window.__player.input?.buttons.A === false);
  const stick = page.locator('[data-stick="left"]');
  await stick.scrollIntoViewIfNeeded();
  const stickBox = await stick.boundingBox();
  await page.mouse.move(stickBox.x + stickBox.width * 0.8, stickBox.y + stickBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.__player.input?.axes.lx > 0.4);
  await page.mouse.up();
  await page.waitForFunction(() => window.__player.input?.axes.lx === 0);
  await page.waitForFunction(() => document.querySelector('#fps').textContent !== '—');
  assert.ok(Number(await page.locator('#fps').textContent()) > 0);
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#pause').textContent === 'Resume');
  await page.waitForFunction(() => document.querySelector('#saveState').dataset.state === 'saved');
  // Allow the one permitted in-flight frame to finish, then verify idle behavior.
  await page.waitForTimeout(150);
  const pausedFrames = await page.evaluate(() => window.__player.frames);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__player.frames), pausedFrames);
  await page.keyboard.down('j');
  assert.equal(await page.evaluate(() => !!window.__player.input?.buttons.A), false);
  await page.keyboard.up('j');
  await page.locator('#pause').click();
  await page.waitForFunction(count => window.__player.frames > count, pausedFrames);
  await page.locator('#mute').click();
  assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'true');
  await page.locator('#volume').fill('35');
  assert.equal(await page.locator('#volumeValue').textContent(), '35%');
  await page.locator('#aspectRatio').selectOption('16/9');
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#sessionState').textContent === 'Ready to play');
  assert.equal(await page.locator('#play').isDisabled(), false);
  assert.equal(await page.locator('#pause').isDisabled(), true);
  assert.equal(await page.evaluate(() => Object.values(window.__player.input.buttons).some(Boolean)), false);
  await fs.mkdir('test-results', { recursive: true });
  await page.locator('#showTouch').uncheck();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `test-results/player-${browserName}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#showTouch').check();
  await page.locator('#aspectRatio').selectOption('4/3');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Phone layout must not overflow horizontally');
  for (const selector of ['#chooseGame', '#play', '#pause', '#stop', '[data-stick="left"]', '[data-stick="right"]']) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${selector} remains inside the phone viewport`);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `test-results/player-${browserName}-phone.png`, fullPage: true });
  await page.reload();
  await page.waitForFunction(() => /^Core ready/.test(document.querySelector('#coreState').textContent), null, { timeout: 120000 });
  assert.equal(await page.locator('#volume').inputValue(), '35');
  assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browserName, checks: ['empty file guard', 'native play', 'keyboard press/release', 'touch capture/release', 'analog stick', 'live FPS', 'pause/resume', 'acknowledged save', 'mute/volume', 'stop', 'phone layout', 'saved preferences'], errors }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
