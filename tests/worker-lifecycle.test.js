import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let instance = 0;
async function loadWorker(t, withCore = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dolphin-worker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (withCore) {
    await mkdir(join(directory, 'core'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'core/dolphin-core.js'), `
      export const calls = [];
      export default async function () {
        return {
          FS: {
            filesystems: { WORKERFS: {}, IDBFS: {} },
            mkdirTree() {}, mount() {}, unmount() {},
            syncfs(populate, done) { done(); },
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
