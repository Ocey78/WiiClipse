import test from 'node:test';
import assert from 'node:assert/strict';
import { DolphinWorkerClient } from '../src/dolphin-worker-client.js';

class FakeWorker {
  constructor() { this.sent = []; this.listeners = new Map(); }
  addEventListener(type, cb) { this.listeners.set(type, cb); }
  postMessage(message) { this.sent.push(message); }
  emit(data) { this.listeners.get('message')?.({ data }); }
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
  client.bootGame(file);
  assert.equal(worker.sent.at(-1).type, 'boot');
  assert.equal(worker.sent.at(-1).file, file);
});
