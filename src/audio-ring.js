// Single producer / single consumer stereo PCM queue. Only the consumer moves READ;
// the producer never overwrites unread samples, including during backlog recovery.
const WRITE = 0, READ = 1, RATE = 2, EPOCH = 3, RESET = 4, DROPPED = 5, UNDERRUN = 6, CLOSED = 7;
const HEADER_BYTES = 32;

export function createPcmRingBuffer({ shared = false, capacityFrames = 4096 } = {}) {
  if (!Number.isInteger(capacityFrames) || capacityFrames < 256 || capacityFrames > 65536 ||
      (capacityFrames & (capacityFrames - 1))) throw new RangeError('PCM capacity must be a power of two between 256 and 65536.');
  const BufferClass = shared ? SharedArrayBuffer : ArrayBuffer;
  const buffer = new BufferClass(HEADER_BYTES + capacityFrames * 4);
  new Int32Array(buffer, 0, 8)[RATE] = 48000;
  return buffer;
}

export class PcmRing {
  constructor(buffer) {
    this.header = new Int32Array(buffer, 0, 8);
    this.samples = new Int16Array(buffer, HEADER_BYTES);
    this.capacity = this.samples.length / 2;
    this.mask = this.capacity - 1;
    this.epoch = -1;
    this.read = 0;
    this.phase = 0;
    this.started = false;
    this.rate = 48000;
  }

  reset(rate = Atomics.load(this.header, RATE)) {
    Atomics.store(this.header, RESET, Atomics.load(this.header, WRITE));
    Atomics.store(this.header, RATE, rate);
    Atomics.add(this.header, EPOCH, 1);
  }

  close() { Atomics.store(this.header, CLOSED, 1); }

  push(input, frames, rate) {
    if (Atomics.load(this.header, CLOSED) || !Number.isFinite(rate) || rate < 8000 || rate > 192000) return 0;
    frames = Math.min(Math.max(0, Math.floor(frames) || 0), input.length >>> 1);
    rate = Math.round(rate);
    if (rate !== Atomics.load(this.header, RATE)) this.reset(rate);
    const write = Atomics.load(this.header, WRITE) >>> 0;
    const read = Atomics.load(this.header, READ) >>> 0;
    const queued = (write - read) >>> 0;
    const limit = Math.min(this.capacity, Math.ceil(rate * 0.08));
    const accepted = Math.min(frames, Math.max(0, limit - queued));
    if (accepted < frames) Atomics.add(this.header, DROPPED, frames - accepted);
    if (!accepted) return 0;
    // For oversized bursts retain the newest accepted tail, not seconds of old sound.
    const start = (frames - accepted) * 2;
    const offset = (write & this.mask) * 2;
    const first = Math.min(accepted * 2, this.samples.length - offset);
    this.samples.set(start === 0 && first === input.length ? input : input.subarray(start, start + first), offset);
    if (first < accepted * 2) this.samples.set(input.subarray(start + first, start + accepted * 2), 0);
    // Publish only after the PCM stores complete.
    Atomics.store(this.header, WRITE, (write + accepted) | 0);
    return accepted;
  }

  render(left, right, outputRate) {
    if (Atomics.load(this.header, CLOSED)) { left.fill(0); right.fill(0); return false; }
    const epoch = Atomics.load(this.header, EPOCH);
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.read = Atomics.load(this.header, RESET) >>> 0;
      this.rate = Atomics.load(this.header, RATE);
      this.phase = 0;
      this.started = false;
    }
    const write = Atomics.load(this.header, WRITE) >>> 0;
    let available = (write - this.read) >>> 0;
    const prefill = Math.min(this.capacity / 4, Math.ceil(this.rate * 0.02));
    const highWater = Math.min(this.capacity * 0.75, Math.ceil(this.rate * 0.06));
    if (available > highWater) {
      const keep = Math.min(this.capacity / 2, Math.ceil(this.rate * 0.03));
      Atomics.add(this.header, DROPPED, available - keep);
      this.read = (write - keep) >>> 0;
      available = keep;
      this.phase = 0;
    }
    if (!this.started && available >= prefill) this.started = true;
    const step = this.rate / outputRate;
    let i = 0;
    if (this.started) {
      for (; i < left.length; i++) {
        const nextPhase = this.phase + step;
        const advance = Math.floor(nextPhase);
        if (available < Math.max(2, advance)) { this.started = false; break; }
        const current = (this.read & this.mask) * 2;
        const next = ((this.read + 1) & this.mask) * 2;
        left[i] = (this.samples[current] + (this.samples[next] - this.samples[current]) * this.phase) / 32768;
        right[i] = (this.samples[current + 1] + (this.samples[next + 1] - this.samples[current + 1]) * this.phase) / 32768;
        this.phase = nextPhase - advance;
        this.read = (this.read + advance) >>> 0;
        available -= advance;
      }
    }
    if (i < left.length) {
      left.fill(0, i); right.fill(0, i);
      Atomics.add(this.header, UNDERRUN, left.length - i);
    }
    // A concurrent title/rate reset invalidates this block; do not emit mixed streams.
    if (Atomics.load(this.header, EPOCH) !== epoch) { left.fill(0); right.fill(0); return true; }
    Atomics.store(this.header, READ, this.read | 0);
    return true;
  }

  get stats() {
    return {
      queuedFrames: (Atomics.load(this.header, WRITE) - Atomics.load(this.header, READ)) >>> 0,
      sourceRate: Atomics.load(this.header, RATE),
      droppedFrames: Atomics.load(this.header, DROPPED) >>> 0,
      underrunFrames: Atomics.load(this.header, UNDERRUN) >>> 0,
    };
  }
}
