import { createPcmRingBuffer, PcmRing } from './audio-ring.js';

export class AudioSink {
  constructor() {
    this.context = null;
    this.node = null;
    this.ring = null;
    this.initializing = null;
    this.mode = 'uninitialized';
    this.paused = false;
    this.sources = new Set();
    this.nextTime = 0;
    this.fallbackDroppedFrames = 0;
  }

  async resume() {
    this.paused = false;
    if (!this.context || this.context.state === 'closed') {
      this.disposeNode();
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.nextTime = this.context.currentTime;
      this.initializing = null;
    }
    // Resume inside the user gesture, before awaiting the worklet module download.
    const context = this.context;
    const resume = context.state === 'suspended' || context.state === 'interrupted'
      ? (this.reset(), context.resume()) : Promise.resolve();
    this.initializing ||= this.initialize(context);
    await Promise.all([resume, this.initializing]);
    await this.reconcileState(context);
    return this.context === context && context.state !== 'closed';
  }

  async initialize(context) {
    if (context.audioWorklet && typeof globalThis.AudioWorkletNode === 'function' &&
        globalThis.crossOriginIsolated && typeof globalThis.SharedArrayBuffer === 'function') {
      try {
        await context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
        if (this.context !== context || context.state === 'closed') return;
        const buffer = createPcmRingBuffer({ shared: true });
        const node = new AudioWorkletNode(context, 'wiiclipse-audio', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { buffer },
        });
        this.ring = new PcmRing(buffer);
        this.node = node;
        this.mode = 'worklet';
        node.onprocessorerror = () => {
          if (this.node !== node || this.context !== context) return;
          this.disposeNode();
          this.initializeFallback(context);
        };
        node.connect(context.destination);
        return;
      } catch {
        if (this.context !== context) return;
        this.disposeNode();
      }
    }
    if (this.context === context && context.state !== 'closed') this.initializeFallback(context);
  }

  initializeFallback(context) {
    // Older browsers can still reuse a single playback node and the same resampler.
    if (typeof context.createScriptProcessor === 'function') {
      this.ring = new PcmRing(createPcmRingBuffer());
      this.node = context.createScriptProcessor(1024, 0, 2);
      this.node.onaudioprocess = ({ outputBuffer }) => this.ring?.render(
        outputBuffer.getChannelData(0), outputBuffer.getChannelData(1), context.sampleRate);
      this.node.connect(context.destination);
      this.mode = 'script';
    } else {
      this.mode = 'scheduled';
    }
  }

  push({ buffer, frames, sampleRate = 48000 }) {
    if (!this.context || this.paused || this.context.state !== 'running' || !buffer || !frames ||
        !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return;
    const input = buffer instanceof Int16Array ? buffer : new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
    frames = Math.min(Math.max(0, Math.floor(frames) || 0), input.length >>> 1);
    if (!frames) return;
    if (this.ring) { this.ring.push(input, frames, sampleRate); return; }
    if (this.mode !== 'scheduled') return;
    this.schedule(input, frames, sampleRate);
  }

  schedule(input, frames, sampleRate) {
    const context = this.context;
    const now = context.currentTime;
    if (this.nextTime < now || this.nextTime > now + 0.08) this.reset();
    const start = Math.max(now + 0.005, this.nextTime);
    const duration = frames / sampleRate;
    if (start + duration > now + 0.08 || this.sources.size >= 32) {
      this.fallbackDroppedFrames += frames;
      return;
    }
    const audio = context.createBuffer(2, frames, sampleRate);
    const left = audio.getChannelData(0);
    const right = audio.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = input[i * 2] / 32768;
      right[i] = input[i * 2 + 1] / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    source.start(start);
    this.nextTime = start + duration;
  }

  reset() {
    this.ring?.reset();
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = this.context?.currentTime || 0;
  }

  async setPaused(paused) {
    this.paused = paused;
    if (!this.context) return;
    if (paused) this.reset();
    await this.reconcileState(this.context);
  }

  async reconcileState(context) {
    // Visibility can change while the browser's resume/suspend promise is pending.
    // Recheck the latest request when that transition completes, without reviving a closed sink.
    while (this.context === context && context.state !== 'closed') {
      const paused = this.paused;
      if (context.state === (paused ? 'suspended' : 'running')) return;
      try {
        await context[paused ? 'suspend' : 'resume']();
      } catch (error) {
        if (this.context !== context || context.state === 'closed') return;
        throw error;
      }
      if (paused === this.paused) return;
    }
  }

  disposeNode() {
    this.ring?.close();
    if (this.node) {
      this.node.onprocessorerror = null;
      this.node.onaudioprocess = null;
      this.node.disconnect();
      this.node.port?.close();
    }
    this.node = null;
    this.ring = null;
  }

  async close() {
    this.reset();
    this.disposeNode();
    const context = this.context;
    this.context = null;
    this.initializing = null;
    this.mode = 'uninitialized';
    if (context && context.state !== 'closed') await context.close();
  }

  get stats() {
    return { mode: this.mode, outputRate: this.context?.sampleRate || 0,
      ...(this.ring?.stats || { droppedFrames: this.fallbackDroppedFrames, queuedSeconds: Math.max(0, this.nextTime - (this.context?.currentTime || 0)) }) };
  }
}
