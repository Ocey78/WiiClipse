import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('failed service worker installation cannot leave app startup waiting forever', async () => {
  const source = fs.readFileSync('src/bootstrap.js', 'utf8').replace("await import('./app.js')", 'startApp()');
  let started = false;
  const context = {
    URL,
    window: { isSecureContext: true, crossOriginIsolated: false },
    location: { href: 'https://example.test/WiiClipse/', pathname: '/WiiClipse/', reload() { throw new Error('Must not reload without worker control'); } },
    navigator: { serviceWorker: { register: async () => ({}), ready: new Promise(() => {}), controller: null } },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { warn() {} },
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    startApp() { started = true; },
  };
  const execution = vm.runInNewContext(`(async () => { ${source} })()`, context);
  const result = await Promise.race([
    execution.then(() => 'finished'),
    new Promise(resolve => setTimeout(() => resolve('stalled'), 50)),
  ]);
  assert.equal(result, 'finished', 'A failed service worker install must time out and start the app');
  assert.equal(started, true);
});
