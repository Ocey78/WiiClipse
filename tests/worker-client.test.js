import test from 'node:test';
import assert from 'node:assert/strict';
import { DolphinWorkerClient } from '../src/dolphin-worker-client.js';

class FakeWorker {
  constructor() { this.sent = []; this.listeners = new Map(); }
  addEventListener(type, cb) { this.listeners.set(type, cb); }
  postMessage(message) { this.sent.push(message); }
  emit(data) { this.listeners.get('message')?.({ data }); }
  fail(message) { this.listeners.get('error')?.({ message }); }
  terminate() { this.terminated = true; }
}

test('worker client performs readiness handshake', async () => {
  const worker = new FakeWorker();
  const client = new DolphinWorkerClient(worker);
  const pending = client.initialize();
  assert.deepEqual(worker.sent[0], { type: 'init' });
  worker.emit({ type: 'ready', version: 'dolphin-test' });
  assert.deepEqual(await pending, { version: 'dolphin-test' });
  assert.equal(client.isReady(), true);
});

test('worker client transfers selected File object without converting it to ArrayBuffer', async () => {
  const worker = new FakeWorker();
  const client = new DolphinWorkerClient(worker);
  const pending = client.initialize();
  worker.emit({ type: 'ready', version: 'test' });
  await pending;
  const file = { name: 'game.iso', size: 1234, slice() {} };
  const boot = client.bootGame(file);
  assert.equal(worker.sent.at(-1).type, 'boot');
  assert.equal(worker.sent.at(-1).file, file);
  worker.emit({ type: 'booted' });
  await boot;
});

async function readyClient(callbacks) {
  const worker = new FakeWorker();
  const client = new DolphinWorkerClient(worker, callbacks);
  const init = client.initialize();
  worker.emit({ type: 'ready', version: 'test' });
  await init;
  return { worker, client };
}

test('unhandled GPU images are released and a failing presenter stops frame submission', async () => {
  let closed = 0;
  const bitmap = { close() { closed++; } };
  const unused = await readyClient();
  unused.worker.emit({ type: 'video', bitmap });
  assert.equal(closed, 1);
  const errors = [];
  const broken = await readyClient({
    onVideo() { throw new Error('Texture upload failed'); },
    onError(error) { errors.push(error.message); },
  });
  broken.worker.emit({ type: 'video', bitmap });
  assert.equal(closed, 2);
  assert.equal(broken.client.isReady(), false);
  assert.equal(broken.client.runFrame(), false);
  assert.deepEqual(errors, ['Texture upload failed']);
});

test('frames wait for confirmed boot and at most one frame is in flight', async () => {
  const { worker, client } = await readyClient();
  const boot = client.bootGame({ name: 'game.iso' });
  let booted = false;
  Promise.resolve(boot).then(() => { booted = true; });
  await Promise.resolve();
  assert.equal(booted, false, 'boot must remain pending until the worker accepts the game');
  client.runFrame();
  assert.equal(worker.sent.filter(({ type }) => type === 'frame').length, 0);
  worker.emit({ type: 'booted' });
  await boot;
  client.runFrame();
  client.runFrame();
  assert.equal(worker.sent.filter(({ type }) => type === 'frame').length, 1);
  worker.emit({ type: 'frame-done' });
  client.runFrame();
  assert.equal(worker.sent.filter(({ type }) => type === 'frame').length, 2);
});

test('rejected game can be retried without reinitializing the native core', async () => {
  const { worker, client } = await readyClient();
  const boot = client.bootGame({ name: 'bad.iso' });
  const rejected = assert.rejects(boot, /rejected/);
  worker.emit({ type: 'error', operation: 'boot', recoverable: true, message: 'Game rejected' });
  await rejected;
  assert.equal(client.isReady(), true);
  client.runFrame();
  assert.equal(worker.sent.some(({ type }) => type === 'frame'), false);
  const retry = client.bootGame({ name: 'good.iso' });
  worker.emit({ type: 'booted' });
  await retry;
  client.runFrame();
  assert.equal(worker.sent.at(-1).type, 'frame');
});

test('worker crash rejects a pending boot and disables further requests', async () => {
  const { worker, client } = await readyClient();
  const boot = client.bootGame({ name: 'game.iso' });
  const rejected = assert.rejects(boot, /crashed/);
  worker.fail('Worker crashed');
  await rejected;
  assert.equal(client.isReady(), false);
  const count = worker.sent.length;
  client.runFrame();
  client.syncSaves();
  assert.equal(worker.sent.length, count);
});

test('failed init dispatch rejects the initialization promise and permits retry', async () => {
  const worker = new FakeWorker();
  const client = new DolphinWorkerClient(worker);
  worker.postMessage = () => { throw new Error('Cannot start worker'); };
  await assert.rejects(async () => client.initialize(), /Cannot start worker/);
  worker.postMessage = FakeWorker.prototype.postMessage;
  const retry = client.initialize();
  assert.equal(worker.sent.at(-1)?.type, 'init');
  worker.emit({ type: 'ready' });
  await retry;
});

test('terminating a loading worker settles its pending initialization', async () => {
  const worker = new FakeWorker();
  const client = new DolphinWorkerClient(worker);
  const init = client.initialize();
  const rejected = assert.rejects(init, /terminated/i);
  client.terminate();
  await rejected;
  assert.equal(client.isReady(), false);
});

test('frame completion can dispatch the next frame immediately and preserves console timing', async () => {
  let client;
  let nextDispatched;
  const ready = await readyClient({ onFrameDone: ({ frameRate }) => {
    assert.equal(frameRate, 50);
    nextDispatched = client.runFrame();
  } });
  client = ready.client;
  const boot = client.bootGame({ name: 'pal.dol' });
  ready.worker.emit({ type: 'booted', frameRate: 50 });
  assert.deepEqual(await boot, { frameRate: 50 });
  assert.equal(client.runFrame(), true);
  assert.equal(client.runFrame(), false);
  ready.worker.emit({ type: 'frame-done', frameRate: 50 });
  assert.equal(nextDispatched, true);
});

test('save requests await matching acknowledgments and persistence errors leave the core usable', async () => {
  const states = [];
  const { worker, client } = await readyClient({ onSaveStatus: status => states.push(status.state) });
  const first = client.syncSaves();
  const second = client.syncSaves();
  assert.ok(first instanceof Promise);
  const [one, two] = worker.sent.filter(m => m.type === 'sync-saves');
  assert.notEqual(one.requestId, two.requestId);
  let done = false;
  first.then(() => { done = true; });
  worker.emit({ type: 'saves-synced', requestId: 999, ok: true });
  await Promise.resolve();
  assert.equal(done, false);
  worker.emit({ type: 'save-status', state: 'saving', message: 'Saving' });
  worker.emit({ type: 'save-status', state: 'error', message: 'Storage full' });
  const rejected = assert.rejects(second, /Storage full/);
  worker.emit({ type: 'saves-synced', requestId: two.requestId, ok: false, message: 'Storage full' });
  await rejected;
  worker.emit({ type: 'saves-synced', requestId: one.requestId, ok: true });
  await first;
  assert.equal(client.isReady(), true);
  assert.deepEqual(states, ['saving', 'error']);
});

test('unload waits for native cleanup before a requested replacement starts', async () => {
  const { worker, client } = await readyClient();
  const unloading = client.unloadGame();
  assert.ok(unloading instanceof Promise);
  const unload = worker.sent.at(-1);
  const replacing = client.bootGame({ name: 'next.dol' });
  assert.equal(worker.sent.at(-1).type, 'unload');
  worker.emit({ type: 'unloaded', requestId: unload.requestId, ok: true });
  await unloading;
  await Promise.resolve();
  assert.equal(worker.sent.at(-1).type, 'boot');
  worker.emit({ type: 'booted' });
  await replacing;
});

test('worker crash settles pending persistence and unload promises', async () => {
  const { worker, client } = await readyClient();
  const save = client.syncSaves();
  const unload = client.unloadGame();
  assert.ok(save instanceof Promise && unload instanceof Promise);
  const rejected = Promise.all([assert.rejects(save, /crashed/), assert.rejects(unload, /crashed/)]);
  worker.fail('Worker crashed');
  await rejected;
});

test('unload requested during boot cannot leave the client running after cleanup', async () => {
  const { worker, client } = await readyClient();
  const boot = client.bootGame({ name: 'loading.dol' });
  const unload = client.unloadGame();
  const requestId = worker.sent.at(-1).requestId;
  worker.emit({ type: 'booted' });
  await boot;
  worker.emit({ type: 'unloaded', requestId, ok: true });
  await unload;
  assert.equal(client.runFrame(), false, 'unloaded titles cannot submit another frame');
});

test('recoverable boot rejection does not reject an unrelated queued save', async () => {
  const { worker, client } = await readyClient();
  const boot = client.bootGame({ name: 'bad.dol' });
  const saving = client.syncSaves();
  const requestId = worker.sent.at(-1).requestId;
  const rejected = assert.rejects(boot, /Rejected/);
  worker.emit({ type: 'error', operation: 'boot', recoverable: true, message: 'Rejected title' });
  await rejected;
  worker.emit({ type: 'saves-synced', requestId, ok: true });
  assert.equal((await saving).ok, true);
});
