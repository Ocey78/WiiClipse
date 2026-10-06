import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcmRingBuffer, PcmRing } from '../src/audio-ring.js';

const stereo = (frames, value = i => i) => {
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { pcm[i * 2] = value(i); pcm[i * 2 + 1] = -value(i); }
  return pcm;
};
const channels = frames => [new Float32Array(frames), new Float32Array(frames)];

test('PCM ring preserves stereo order across physical ring wrap without allocating output', () => {
  const buffer = createPcmRingBuffer();
  const writer = new PcmRing(buffer);
  const reader = new PcmRing(buffer);
  const [left, right] = channels(1024);
  for (let block = 0; block < 8; block++) {
    writer.push(stereo(1024, i => block * 1024 + i), 1024, 48000);
    reader.render(left, right, 48000);
    // One lookahead frame is retained after an underrun, then consumed on recovery.
    for (let i = 0; i < (block === 0 ? 1023 : 1024); i++) {
      const value = (block === 0 ? 0 : block * 1024 - 1) + i;
      assert.equal(left[i], value / 32768);
      assert.equal(right[i], value === 0 ? 0 : -value / 32768);
    }
    assert.ok(left.some(sample => sample !== 0));
    assert.ok(writer.stats.queuedFrames <= 1);
  }
});

test('resampling maintains pitch and fractional position across render quanta at actual context rates', () => {
  for (const [sourceRate, outputRate] of [[32000, 48000], [32029, 44100], [48000, 44100], [48000, 48000]]) {
    const ring = new PcmRing(createPcmRingBuffer());
    ring.push(stereo(1800), 1800, sourceRate);
    const [left, right] = channels(128);
    for (let block = 0; block < 6; block++) {
      ring.render(left, right, outputRate);
      for (let i = 0; i < 128; i++) {
        const expected = (block * 128 + i) * sourceRate / outputRate / 32768;
        assert.ok(Math.abs(left[i] - expected) < 1e-6, `${sourceRate}->${outputRate} sample ${block * 128 + i}`);
        assert.ok(Math.abs(right[i] + expected) < 1e-6);
      }
    }
  }
});

test('underrun produces silence, waits for refill, and never replays stale samples after reset', () => {
  const ring = new PcmRing(createPcmRingBuffer());
  const [left, right] = channels(128);
  ring.push(stereo(100, () => 12000), 100, 48000);
  left.fill(1); right.fill(1);
  ring.render(left, right, 48000);
  assert.ok(left.every(sample => sample === 0));
  ring.push(stereo(1000, () => 12000), 1000, 48000);
  for (let i = 0; i < 10; i++) ring.render(left, right, 48000);
  assert.ok(left.every(sample => sample === 0));
  assert.ok(ring.stats.underrunFrames > 0);
  ring.reset();
  ring.push(stereo(1024, () => 5000), 1024, 48000);
  ring.render(left, right, 48000);
  assert.ok(left.every(sample => sample === 5000 / 32768));
});

test('oversized bursts keep bounded recent PCM and discard excess latency', () => {
  const ring = new PcmRing(createPcmRingBuffer());
  const input = stereo(12000, i => i);
  ring.push(input, 12000, 48000);
  assert.ok(ring.stats.queuedFrames <= 48000 * 0.08);
  const [left, right] = channels(128);
  ring.render(left, right, 48000);
  assert.ok(ring.stats.queuedFrames <= 48000 * 0.03);
  assert.ok(left[0] > 10000 / 32768, 'Backlog recovery uses recent audio, not the start of an oversized burst');
  assert.ok(ring.stats.droppedFrames > 8000);
});

test('sample-rate changes flush the previous stream before resampling the new one', () => {
  const ring = new PcmRing(createPcmRingBuffer());
  ring.push(stereo(1600, () => 24000), 1600, 48000);
  const [left, right] = channels(128);
  ring.render(left, right, 44100);
  ring.push(stereo(1000, () => 4000), 1000, 32029);
  ring.render(left, right, 44100);
  assert.equal(ring.stats.sourceRate, 32029);
  assert.ok(left.every(sample => sample === 4000 / 32768));
  ring.close();
  assert.equal(ring.render(left, right, 44100), false);
  assert.ok(left.every(sample => sample === 0));
});
