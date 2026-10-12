import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingPointProbe } from '../native/tests/fp-boot-probe.mjs';

test('original FP probe is an aligned DOL with arithmetic-dependent visible success', () => {
  const probe = createFloatingPointProbe();
  assert.equal(probe.bytes.readUInt32BE(0), 0x100);
  assert.equal(probe.bytes.readUInt32BE(0x48), 0x80003100);
  assert.equal(probe.bytes.readUInt32BE(0xe0), 0x80003100);
  const size = probe.bytes.readUInt32BE(0x90);
  assert.equal(size % 32, 0); assert.equal(size + 0x100, probe.bytes.length);
  assert.deepEqual(probe.samples[0], { x: 80, y: 120, r: 255, g: 255, b: 255 });
  assert.equal(probe.floatingPoint.markerAddress, 0xc01258a0);
  assert.equal(probe.floatingPoint.expected.length, 8);
  const words = Array.from({ length: size / 4 }, (_, i) => probe.bytes.readUInt32BE(0x100 + i * 4));
  assert.ok(words.includes(0x7d6000a6), 'mfmsr r11 preserves the bootstrap mapping flags');
  assert.ok(words.includes(0x616b2000), 'enable only MSR.FP');
  assert.ok(words.includes(0x7d600124), 'mtmsr r11');
  for (const { word, bits } of probe.floatingPoint.expected) {
    assert.ok(words.includes(word)); assert.match(bits, /^[0-9a-f]{16}$/);
  }
  const failures = words.map((word, index) => ({ word, index })).filter(({ word }) => (word & 0xffff0000) === 0x40820000);
  assert.equal(failures.length, 17); // original row loop + 16 result-word checks
  for (const { word, index } of failures.slice(1)) {
    const displacement = (word << 16) >> 16;
    assert.equal(index + displacement / 4, probe.floatingPoint.failureWord);
  }
  // Every fallthrough basic block after a result check starts with an FP op:
  // stfd for the next result or fmr for low-word/success checks. Thus compiled
  // calls after a warm reset prove FPU admission, not unrelated integer work.
  for (const { index } of failures.slice(1)) assert.ok([54, 63].includes(words[index + 1] >>> 26));
  const tail = words.slice(probe.floatingPoint.loopWord);
  assert.ok(tail.filter(word => word >>> 26 === 54).length >= 8, 'all computed doubles reach RAM');
  assert.ok(tail.filter(word => word >>> 26 === 32).length >= 16, 'both halves are verified by actual integer loads');
});

test('FP probe generation is reproducible and contains only its original code/data constants', () => {
  const first = createFloatingPointProbe(), second = createFloatingPointProbe();
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.fileName, 'wiiclipse-fp-probe.dol');
  assert.equal(first.width, 640); assert.equal(first.height, 240);
});
