import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSink } from '../src/audio-sink.js';
import { PcmRing } from '../src/audio-ring.js';

function environment(t, { worklet = true, script = true, moduleFailure = false, resumeFailure = false, addModule } = {}) {
  const calls = { buffers: 0, sources: 0, worklets: [], scripts: [], events: [] };
  class Context {
    constructor() {
      this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0; this.destination = {};
      if (worklet) this.audioWorklet = { addModule: async url => {
        calls.events.push('module');
        assert.match(url.href, /\/audio-worklet\.js$/);
        if (moduleFailure) throw new Error('module unavailable');
        if (addModule) await addModule();
      } };
      if (script) this.createScriptProcessor = () => {
        const node = { connect() {}, disconnect() { this.disconnected = true; } };
        calls.scripts.push(node); return node;
      };
    }
    async resume() { calls.events.push('resume'); if (resumeFailure) throw new Error('gesture required'); this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    createBuffer(channels, frames, rate) {
      calls.buffers++;
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / rate, getChannelData: i => data[i] };
    }
    createBufferSource() {
      calls.sources++;
      return { connect() {}, disconnect() {}, start(time) { this.time = time; }, stop() { this.stopped = true; } };
    }
  }
  class WorkletNode {
    constructor(context, name, options) {
      this.options = options; this.port = { close() {} };
      assert.equal(name, 'wiiclipse-audio'); calls.worklets.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  for (const [key, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: WorkletNode, crossOriginIsolated: true })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, key, prior) : delete globalThis[key]);
  }
  return calls;
}

test('worklet path resumes within the gesture and streams 5000 chunks using one node and fixed PCM storage', async t => {
  const calls = environment(t);
  const sink = new AudioSink();
  await sink.resume();
  assert.deepEqual(calls.events.slice(0, 2), ['resume', 'module']);
  assert.equal(sink.mode, 'worklet');
  const reader = new PcmRing(calls.worklets[0].options.processorOptions.buffer);
  const left = new Float32Array(96), right = new Float32Array(96);
  const input = new Int16Array(192).fill(8192);
  for (let i = 0; i < 5000; i++) {
    sink.push({ buffer: input.buffer, frames: 96, sampleRate: 48000 });
    reader.render(left, right, 48000);
  }
  assert.equal(calls.worklets.length, 1);
  assert.equal(calls.buffers, 0);
  assert.equal(calls.sources, 0);
  assert.equal(reader.samples.byteLength, 16384);
  assert.ok(left.every(sample => sample === 0.25));
  assert.ok(sink.stats.queuedFrames <= 3840);
  await sink.close();
  assert.equal(calls.worklets[0].disconnected, true);
});

test('unavailable worklet falls back to one reusable ScriptProcessor with source-rate conversion', async t => {
  const calls = environment(t, { moduleFailure: true });
  const sink = new AudioSink();
  await sink.resume();
  assert.equal(sink.mode, 'script');
  sink.push({ buffer: new Int16Array(2000).fill(16384).buffer, frames: 1000, sampleRate: 32029 });
  const channels = [new Float32Array(128), new Float32Array(128)];
  calls.scripts[0].onaudioprocess({ outputBuffer: { getChannelData: i => channels[i] } });
  assert.ok(channels[0].every(sample => sample === 0.5));
  assert.equal(sink.stats.sourceRate, 32029);
  assert.equal(calls.buffers, 0);
  assert.equal(calls.sources, 0);
  await sink.close();
});

test('scheduled-source fallback bounds backlog and reset cancels all queued sound', async t => {
  const calls = environment(t, { worklet: false, script: false });
  const sink = new AudioSink();
  await sink.resume();
  const pcm = new Int16Array(192).buffer;
  for (let i = 0; i < 5000; i++) sink.push({ buffer: pcm, frames: 96 });
  assert.ok(calls.sources <= 32);
  assert.ok(sink.stats.queuedSeconds <= 0.08);
  assert.ok(sink.stats.droppedFrames > 0);
  const sources = [...sink.sources];
  sink.reset();
  assert.ok(sources.every(source => source.stopped));
  assert.equal(sink.sources.size, 0);
  await sink.close();
});

test('autoplay rejection remains visible and paused contexts do not accumulate PCM', async t => {
  environment(t, { resumeFailure: true });
  const sink = new AudioSink();
  await assert.rejects(sink.resume(), /gesture required/);
  sink.push({ buffer: new Int16Array(2048).buffer, frames: 1024 });
  assert.equal(sink.stats.queuedFrames, 0);
  await sink.close();
});

test('pause clears old sound and resumes the existing playback node', async t => {
  const calls = environment(t);
  const sink = new AudioSink();
  await sink.resume();
  sink.push({ buffer: new Int16Array(2048).fill(8000).buffer, frames: 1024 });
  await sink.setPaused(true);
  assert.equal(sink.context.state, 'suspended');
  await sink.setPaused(false);
  const reader = new PcmRing(calls.worklets[0].options.processorOptions.buffer);
  const left = new Float32Array(128), right = new Float32Array(128);
  reader.render(left, right, 44100);
  assert.ok(left.every(sample => sample === 0));
  assert.equal(calls.worklets.length, 1);
  await sink.close();
});

test('closing during module load cannot attach a node to a discarded context', async t => {
  let finish;
  const calls = environment(t, { addModule: () => new Promise(resolve => { finish = resolve; }) });
  const sink = new AudioSink();
  const pending = sink.resume();
  await sink.close();
  finish();
  await pending;
  assert.equal(calls.worklets.length, 0);
  assert.equal(sink.context, null);
});

test('pause requested during a pending resume wins when the browser finishes resuming', async t => {
  environment(t, { worklet: false, script: false });
  const Base = globalThis.AudioContext;
  let finishResume;
  globalThis.AudioContext = class extends Base {
    resume() { return new Promise(resolve => { finishResume = () => { this.state = 'running'; resolve(); }; }); }
  };
  const sink = new AudioSink();
  const pending = sink.resume();
  await sink.setPaused(true);
  finishResume();
  await pending;
  assert.equal(sink.paused, true);
  assert.equal(sink.context.state, 'suspended');
  await sink.close();
});

test('unpause requested during a pending suspend restores playback after suspension finishes', async t => {
  environment(t, { worklet: false, script: false });
  const Base = globalThis.AudioContext;
  let finishSuspend;
  globalThis.AudioContext = class extends Base {
    suspend() { return new Promise(resolve => { finishSuspend = () => { this.state = 'suspended'; resolve(); }; }); }
  };
  const sink = new AudioSink();
  await sink.resume();
  const pending = sink.setPaused(true);
  await sink.setPaused(false);
  finishSuspend();
  await pending;
  assert.equal(sink.paused, false);
  assert.equal(sink.context.state, 'running');
  await sink.close();
});
