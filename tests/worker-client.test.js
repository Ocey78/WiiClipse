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
