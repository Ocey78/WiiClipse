import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
try {
  browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => {
    const state = document.querySelector('#coreState')?.textContent || '';
    return /not built|ready|unavailable/i.test(state);
  });
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 });
  // One first-visit reload should have made the page isolated before app startup.
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'Pages startup must enable cross-origin isolation');
  assert.equal(await page.evaluate(() => typeof SharedArrayBuffer), 'function');
  const coreState = await page.locator('#coreState').textContent();
  assert.match(coreState, /not built|ready/i, 'Worker must either initialize or report the known missing core, not an unrelated startup failure');
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#gameFile').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('not a game') });
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#gameFile').setInputFiles({ name: 'homebrew.dol', mimeType: 'application/octet-stream', buffer: Buffer.from('selection test only; not an executable') });
  assert.equal(await page.locator('#gameName').textContent(), 'homebrew.dol');
  if (!/ready/i.test(coreState)) assert.equal(await page.locator('#play').isDisabled(), true, 'Missing core must never enable Play');
  await page.reload();
  await page.waitForFunction(() => /not built|ready|unavailable/i.test(document.querySelector('#coreState')?.textContent || ''));
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  // Give successful asset fetches time to finish their event.waitUntil cache writes.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#chooseGame').waitFor();
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.deepEqual(errors, [], 'App startup must not throw uncaught errors');
  console.log(JSON.stringify({ browser: browserName, url, coreState, checks: ['first visit', 'isolation', 'SharedArrayBuffer', 'file selection', 'missing-core guard', 'reload', 'offline shell', 'no uncaught errors'] }));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
