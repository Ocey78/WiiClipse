import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootProbe } from '../native/tests/boot-probe.mjs';

test('original boot probe is an aligned single-text-section GameCube DOL', () => {
  const probe = createBootProbe();
  const dol = Buffer.from(probe.bytes);
  assert.ok(dol.length >= 0x120, 'A DOL header and executable text are required');
  assert.equal(probe.fileName, 'wiiclipse-boot-probe.dol');
  assert.equal(dol.readUInt32BE(0x00), 0x100);
  assert.equal(dol.readUInt32BE(0x48), 0x80003100);
  assert.equal(dol.readUInt32BE(0xe0), 0x80003100);
  assert.equal(dol.readUInt32BE(0x90), dol.length - 0x100);
  assert.equal(dol.readUInt32BE(0x90) % 32, 0);
  // No injected framebuffer/data: seeing colors requires executing PPC stores.
  for (let offset = 0x1c; offset < 0x48; offset += 4) assert.equal(dol.readUInt32BE(offset), 0);
  for (let offset = 0xac; offset < 0xd8; offset += 4) assert.equal(dol.readUInt32BE(offset), 0);
  for (let offset = 0x100; offset < dol.length; offset += 4) {
    assert.notEqual((dol.readUInt32BE(offset) & 0xfc1fffff) >>> 0, 0x7c13fba6,
      'No HID4 write: Dolphin must identify this probe as GameCube');
  }
});

test('probe count branches return to framebuffer stores and finish in a self loop', () => {
  const { bytes } = createBootProbe();
  const dol = Buffer.from(bytes);
  assert.ok(dol.length >= 0x120);
  const words = [];
  for (let offset = 0x100; offset < dol.length; offset += 4) words.push(dol.readUInt32BE(offset));
  assert.equal(words[0], 0x3c60c010, 'lis r3,0xc010 selects uncached XFB RAM');
  assert.equal(words[1], 0x38e000f0, 'li r7,240 selects 240 rows');
  let pixelLoops = 0;
  let rowLoops = 0;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word >>> 26 !== 16) continue;
    const displacement = (word << 16) >> 16;
    const target = index + (displacement & ~3) / 4;
    assert.ok(target >= 0 && target < words.length, 'Branch target must remain inside text');
    if (word >>> 16 === 0x4200) {
      pixelLoops++;
      assert.equal(words[target], 0x90830000, 'bdnz must repeat stw r4,0(r3)');
      assert.equal(words[target + 1], 0x38630004, 'The next YUYV pair is four bytes later');
      assert.equal(words[target - 2], 0x38c00050, '80 pairs make each 160-pixel stripe');
      assert.equal(words[target - 1], 0x7cc903a6, 'mtctr r6 sets the pixel count');
    } else {
      rowLoops++;
      assert.equal(word >>> 16, 0x4082, 'The outer row loop uses bne');
      assert.equal(target, 2, 'The next row starts with the red stripe');
    }
  }
  assert.equal(pixelLoops, 4);
  assert.equal(rowLoops, 1);
  assert.ok(words.includes(0x48000000), 'Program ends with b . after VI setup');
});

test('probe expectations describe four visible primary-color stripes', () => {
  const { width, height, samples } = createBootProbe();
  assert.equal(width, 640);
  assert.equal(height, 240);
  assert.deepEqual(samples, [
    { x: 80, y: 120, r: 255, g: 0, b: 0 },
    { x: 240, y: 120, r: 0, g: 255, b: 0 },
    { x: 400, y: 120, r: 0, g: 0, b: 255 },
    { x: 560, y: 120, r: 255, g: 255, b: 255 },
  ]);
});
