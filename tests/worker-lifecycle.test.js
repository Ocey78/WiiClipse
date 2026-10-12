import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let instance = 0;
async function loadWorker(t, withCore = false, { workerfs = true, deferSaves = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dolphin-worker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (withCore) {
    await mkdir(join(directory, 'core'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'core/dolphin-core.js'), `
      export const calls = [];
      export const pendingSyncs = [];
      export const behavior = { cleanupError: null, restoreError: null };
      export default async function () {
        return {
          FS: {
            filesystems: { ${workerfs ? 'WORKERFS: {},' : ''} IDBFS: {} },
            mkdirTree() {},
            mount(...args) { calls.push(['mount', ...args]); },
            unmount(...args) { calls.push(['unmount', ...args]); if (behavior.cleanupError) throw new Error(behavior.cleanupError); },
            writeFile(...args) { calls.push(['writeFile', ...args]); },
            unlink(...args) { calls.push(['unlink', ...args]); },
            syncfs(populate, done) { calls.push(['sync', populate]); if (populate && behavior.restoreError) done(new Error(behavior.restoreError)); else if (!populate && ${deferSaves}) pendingSyncs.push(done); else done(); },
          },
          cwrap(name) {
            return (...args) => {
              calls.push([name, ...args]);
              if (name === 'dweb_load_game') return !args[0].includes('bad');
              if (name === 'dweb_version') return 'test-fixture';
              return 1;
            };
          },
        };
      }
    `);
  }
  const messages = [];
  let receive;
  const previousSelf = globalThis.self;
  globalThis.self = {
    location: { href: pathToFileURL(join(directory, 'src/dolphin-worker.js')).href },
    postMessage(message) { messages.push(message); },
    addEventListener(type, listener) { if (type === 'message') receive = listener; },
  };
  t.after(() => { globalThis.self = previousSelf; });
  await import(`../src/dolphin-worker.js?test=${++instance}`);
  const fixture = withCore ? await import(pathToFileURL(join(directory, 'core/dolphin-core.js')).href) : null;
  return { messages, fixture, send: (data) => receive({ data }) };
}

test('missing native build reports unavailable without ever reporting ready', async (t) => {
  const worker = await loadWorker(t);
  await worker.send({ type: 'init' });
  assert.equal(worker.messages.at(-1).type, 'unavailable');
  assert.match(worker.messages.at(-1).message, /not installed/i);
  assert.equal(worker.messages.some(({ type }) => type === 'ready'), false);
});

test('save sync before native initialization is harmless', async (t) => {
  const worker = await loadWorker(t);
  await worker.send({ type: 'sync-saves' });
  assert.equal(worker.messages.some(({ type }) => type === 'error'), false);
});

test('worker acknowledges native boot and frame completion', async (t) => {
  const worker = await loadWorker(t, true);
  await worker.send({ type: 'init' });
  assert.equal(worker.messages.at(-1).type, 'ready');
  assert.ok(worker.messages.some(message => message.type === 'save-status' && message.state === 'ready'), 'Successful restoration makes local storage readiness visible');
  await worker.send({ type: 'boot', file: { name: 'good.iso' } });
  assert.ok(worker.messages.some(({ type }) => type === 'booted'));
  assert.ok(worker.fixture.calls.some(([name, path]) => name === 'dweb_load_game' && path === '/content/good.iso'));
  await worker.send({ type: 'frame' });
  assert.equal(worker.messages.at(-1).type, 'frame-done');
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'dweb_run_frame').length, 1);
});

test('rejected native boot is recoverable and never runs a frame', async (t) => {
  const worker = await loadWorker(t, true);
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'bad.iso' } });
  assert.equal(worker.messages.at(-1).type, 'error');
  assert.equal(worker.messages.at(-1).operation, 'boot');
  assert.equal(worker.messages.at(-1).recoverable, true);
  await worker.send({ type: 'frame' });
  assert.equal(worker.fixture.calls.some(([name]) => name === 'dweb_run_frame'), false);
  await worker.send({ type: 'boot', file: { name: 'good.iso' } });
  assert.ok(worker.messages.some(({ type }) => type === 'booted'));
});

const turn = () => new Promise(resolve => setImmediate(resolve));

test('overlapping save requests use one transaction and acknowledge every caller', async t => {
  const worker = await loadWorker(t, true, { deferSaves: true });
  await worker.send({ type: 'init' });
  const first = worker.send({ type: 'sync-saves', requestId: 1 });
  const second = worker.send({ type: 'sync-saves', requestId: 2 });
  await turn();
  assert.equal(worker.fixture.pendingSyncs.length, 1, 'only one persistence transaction may run');
  worker.fixture.pendingSyncs.shift()();
  await Promise.all([first, second]);
  assert.deepEqual(worker.messages.filter(m => m.type === 'saves-synced').map(m => [m.requestId, m.ok]), [[1, true], [2, true]]);
  assert.deepEqual(worker.messages.filter(m => m.type === 'save-status').map(m => m.state), ['ready', 'saving', 'saved']);
});

test('unload finishes persistence before a concurrent replacement mounts', async t => {
  const worker = await loadWorker(t, true, { deferSaves: true });
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'first.dol' } });
  const unloading = worker.send({ type: 'unload', requestId: 3 });
  const replacing = worker.send({ type: 'boot', file: { name: 'second.dol' } });
  await turn();
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'mount').length, 2, 'replacement must wait for old title cleanup');
  worker.fixture.pendingSyncs.shift()();
  await Promise.all([unloading, replacing]);
  assert.ok(worker.messages.some(m => m.type === 'unloaded' && m.requestId === 3 && m.ok));
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'mount').length, 3);
});

test('save failure is reported and does not stop frame execution', async t => {
  const worker = await loadWorker(t, true, { deferSaves: true });
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'first.dol' } });
  const saving = worker.send({ type: 'sync-saves', requestId: 4 });
  await turn();
  worker.fixture.pendingSyncs.shift()(new Error('Storage full'));
  await saving;
  assert.ok(worker.messages.some(m => m.type === 'saves-synced' && m.requestId === 4 && !m.ok && /Storage full/.test(m.message)));
  assert.ok(worker.messages.some(m => m.type === 'save-status' && m.state === 'error'));
  await worker.send({ type: 'frame' });
  assert.ok(worker.fixture.calls.some(([name]) => name === 'dweb_run_frame'));
});

test('copied fallback files are removed when unloading a title', async t => {
  const worker = await loadWorker(t, true, { workerfs: false });
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'copied.dol', arrayBuffer: async () => new ArrayBuffer(4) } });
  await worker.send({ type: 'unload', requestId: 5 });
  assert.ok(worker.fixture.calls.some(([name, path]) => name === 'unlink' && path === '/content/copied.dol'));
  assert.ok(!worker.fixture.calls.some(([name]) => name === 'unmount'), 'a copied file has no WORKERFS mount');
});

test('failed mount cleanup is acknowledged and can be retried before replacement', async t => {
  const worker = await loadWorker(t, true);
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'first.dol' } });
  worker.fixture.behavior.cleanupError = 'Could not release mounted file';
  await worker.send({ type: 'unload', requestId: 6 });
  assert.ok(worker.messages.some(m => m.type === 'unloaded' && m.requestId === 6 && !m.ok));
  await worker.send({ type: 'boot', file: { name: 'second.dol' } });
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'mount').length, 2, 'cannot overwrite the unreleased mount');
  worker.fixture.behavior.cleanupError = null;
  await worker.send({ type: 'unload', requestId: 7 });
  await worker.send({ type: 'boot', file: { name: 'second.dol' } });
  assert.ok(worker.messages.some(m => m.type === 'unloaded' && m.requestId === 7 && m.ok));
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'mount').length, 3);
});

test('unavailable persistent storage permits local emulation and reports failed saves', async t => {
  const worker = await loadWorker(t, true);
  worker.fixture.behavior.restoreError = 'IndexedDB access denied';
  await worker.send({ type: 'init' });
  assert.equal(worker.messages.at(-1).type, 'ready', 'storage restrictions must not disable local emulation');
  assert.ok(worker.messages.some(m => m.type === 'save-status' && m.state === 'error' && /IndexedDB/.test(m.message)));
  await worker.send({ type: 'boot', file: { name: 'local.dol' } });
  await worker.send({ type: 'sync-saves', requestId: 8 });
  assert.ok(worker.messages.some(m => m.type === 'saves-synced' && m.requestId === 8 && !m.ok));
  assert.ok(!worker.messages.some(m => m.type === 'save-status' && m.state === 'saved'));
  await worker.send({ type: 'frame' });
  assert.ok(worker.fixture.calls.some(([name]) => name === 'dweb_run_frame'));
});

test('periodic and explicit saves coalesce and frame writes wait for persistence', async t => {
  const worker = await loadWorker(t, true, { deferSaves: true });
  await worker.send({ type: 'init' });
  await worker.send({ type: 'boot', file: { name: 'local.dol' } });
  for (let i = 0; i < 600; i++) await worker.send({ type: 'frame' });
  await turn();
  const explicit = worker.send({ type: 'sync-saves', requestId: 9 });
  const nextFrame = worker.send({ type: 'frame' });
  await turn();
  assert.equal(worker.fixture.pendingSyncs.length, 1);
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'dweb_run_frame').length, 600);
  worker.fixture.pendingSyncs.shift()();
  await Promise.all([explicit, nextFrame]);
  assert.equal(worker.fixture.calls.filter(([name]) => name === 'dweb_run_frame').length, 601);
  assert.ok(worker.messages.some(m => m.type === 'saves-synced' && m.requestId === 9 && m.ok));
});
