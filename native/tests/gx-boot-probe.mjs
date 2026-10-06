// SPDX-License-Identifier: GPL-2.0-or-later
// Original GX workload: no game, firmware, SDK binary, or rendered image.
// Register/packet references:
// https://github.com/devkitPro/libogc/blob/master/libogc/gx.c
// Dolphin f8603f14e7f5a090e6693857d625a55ea9330534:
// VideoCommon/{CommandProcessor,CPMemory,XFMemory,BPMemory,OpcodeDecoding}.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDTH = 640;
const HEIGHT = 480;
const XFB = 0x00100000;
const FIFO_A = 0x00200000;
const FIFO_SIZE = 0x10000;
const ENTRY = 0x80003100;

function gxCommands(layers, alternate) {
  const bytes = [];
  const u8 = value => bytes.push(value & 255);
  const u16 = value => { u8(value >>> 8); u8(value); };
  const u32 = value => { u16(value >>> 16); u16(value); };
  const f32 = value => { const b = Buffer.alloc(4); b.writeFloatBE(value); u32(b.readUInt32BE()); };
  const bp = (address, value) => { u8(0x61); u32((address << 24) | value); };
  const cp = (address, value) => { u8(0x08); u8(address); u32(value); };
  const xf = (address, values, floats = false) => {
    u8(0x10); u16(values.length - 1); u16(address);
    values.forEach(floats ? f32 : u32);
  };
  const triangle = (points, z, rgba, repeat = 1) => {
    u8(0x90); u16(repeat * 3); // GX_TRIANGLES, VAT0, direct XYZ float + RGBA8
    for (let i = 0; i < repeat; i++) {
      for (const [x, y] of points) {
        f32(x / 320 - 1); f32(1 - y / 240); f32(z);
        rgba.forEach(u8);
      }
    }
  };

  bp(0xfe, 0xffffff); // all BP register bits writable
  cp(0x30, 0); cp(0x40, 0); // position/texture matrix indices
  cp(0x50, 0x2200); cp(0x60, 0); // direct position and color0, no normals/texcoords
  cp(0x70, 0x16009); cp(0x80, 0); cp(0x90, 0); // XYZ/F32, RGBA/RGBA8
  xf(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], true); // identity position matrix
  xf(0x1005, [0]); // clipping enabled
  xf(0x1008, [1, 1]); // one vertex color; one color channel
  xf(0x100e, [1]); xf(0x1010, [1]); // unlit color/alpha from vertex material
  xf(0x1018, [0, 0]);
  xf(0x101a, [320, -240, 16777215, 662, 582, 16777215], true);
  xf(0x1020, [1, 0, 1, 0, 1, 0], true); xf(0x1026, [1]); // orthographic clip coordinates
  xf(0x103f, [0]); // no texture generators

  bp(0x00, 0x10); // one color channel, one TEV stage, no culling/AA/indirect textures
  for (let i = 1; i <= 4; i++) bp(i, 0x666666); // centered EFB sample locations
  bp(0x10, 0); bp(0x28, 0); // no indirect texture, raster color0, texture disabled
  bp(0x20, (342 << 12) | 342);
  bp(0x21, ((342 + WIDTH - 1) << 12) | (342 + HEIGHT - 1));
  bp(0x59, (171 << 10) | 171); // scissor offset removes the hardware +342 origin
  bp(0x40, 0x17); // Z test LEQUAL and Z updates
  bp(0x41, 0x18); // color and alpha updates, blending disabled
  bp(0x42, 0); bp(0x43, 0); bp(0x44, 3); bp(0x68, 0); // RGB8/Z24, both fields
  bp(0xc0, 0x08fffa); bp(0xc1, 0x08ffd0); // TEV pass raster color/alpha, clamp
  bp(0xf6, 4); bp(0xf7, 14); // identity RGBA raster swap table
  bp(0xf1, 0); bp(0xf3, 0x3f0000); bp(0xf5, 0); // no fog/Z texture; alpha always passes
  bp(0x49, 0); bp(0x4a, ((HEIGHT - 1) << 10) | (WIDTH - 1));
  bp(0x4b, XFB >>> 5); bp(0x4d, WIDTH / 16); bp(0x4e, 256); // full-size YUYV copy
  bp(0x4f, 0xff00); bp(0x50, 0x000080); bp(0x51, 0xffffff); // clear navy, far Z
  bp(0x53, 0x595000); bp(0x54, 0x15); // unit-gain copy filter
  bp(0x52, 0x4803); // initial EFB clear (copy then clear), clamp top/bottom

  const large = [[320, 48], [64, 432], [576, 432]];
  triangle(large, -0.5, alternate ? [0, 255, 0, 255] : [255, 0, 0, 255], layers);
  triangle(large, -0.25, [255, 255, 255, 255]); // farther white must be rejected
  bp(0x41, 0x4b9); // source-alpha / inverse-source-alpha blending
  triangle([[320, 192], [192, 384], [448, 384]], -0.75, [0, 0, 255, 128]);
  bp(0x41, 0x18);
  bp(0x52, 0x4803); // finished EFB -> XFB, then clear for the following frame
  bp(0x47, alternate ? 2 : 1); // PE token after the draw/copy sequence
  while (bytes.length % 32) u8(0); // CP consumes full 32-byte FIFO bursts
  return Buffer.from(bytes);
}

export function createGxBootProbe({ layers = 8 } = {}) {
  if (!Number.isInteger(layers) || layers < 1 || layers > 256) throw new RangeError('layers must be an integer from 1 to 256.');
  const streams = [gxCommands(layers, false), gxCommands(layers, true)];
  const commandBytes = streams[0].length;
  if (commandBytes >= FIFO_SIZE || streams[1].length !== commandBytes) throw new RangeError('GX packet does not fit the FIFO.');

  const words = [];
  const labels = new Map();
  const branches = [];
  const emit = word => words.push(word >>> 0);
  const d = (op, reg, base, immediate) => emit((op << 26) | (reg << 21) | (base << 16) | (immediate & 0xffff));
  const li = (reg, value) => d(14, reg, 0, value);
  const load32 = (reg, value) => { d(15, reg, 0, value >>> 16); d(24, reg, reg, value); };
  const label = name => labels.set(name, words.length);
  const branch = (opcode, target) => { branches.push({ index: words.length, opcode, target }); emit(0); };
  load32(9, 0xcc002000);
  const vi16 = (offset, value) => { li(4, value); d(44, 4, 9, offset); };
  const vi32 = (offset, value) => { load32(4, value); d(36, 4, 9, offset); };
  vi16(0x02, 0);
  vi16(0x00, (HEIGHT << 4) | 6);
  // 1050 half-lines/field at 54MHz gives the normal NTSC field frequency.
  vi32(0x0c, (24 << 16) | 48); vi32(0x10, (24 << 16) | 48);
  vi16(0x48, 0x2828); vi16(0x6c, 1);
  vi32(0x1c, XFB); vi32(0x24, XFB);
  vi32(0x30, 0); vi32(0x34, 0); // masked VI interrupts; no interrupt handler
  vi16(0x02, 5);
  load32(5, 0xcc000000); // CP register bank, uncached bootstrap mapping
  const cp16 = (offset, value) => { li(4, value); d(44, 4, 5, offset); };
  cp16(0x02, 0); // unlinked FIFO, reads/interrupts disabled while configuring
  cp16(0x20, 0); cp16(0x24, FIFO_SIZE - 32);
  cp16(0x28, 0xe000); cp16(0x2a, 0); cp16(0x2c, 0x2000); cp16(0x2e, 0);
  cp16(0x34, commandBytes); cp16(0x38, 0);
  load32(10, FIFO_A);
  label('submit');
  cp16(0x02, 0);
  // srwi r4,r10,16: the two packets occupy 0x00200000 and 0x00210000.
  emit((21 << 26) | (10 << 21) | (4 << 16) | (16 << 11) | (16 << 6) | (31 << 1));
  for (const offset of [0x22, 0x26, 0x36, 0x3a]) d(44, 4, 5, offset);
  cp16(0x38, 0); // reset read pointer to the selected packet
  cp16(0x30, commandBytes); cp16(0x32, 0);
  emit(0x7c0004ac); // sync before enabling CP
  cp16(0x02, 1); // GP reads enabled; actual CP/XF/BP/primitive decoding starts here
  label('drain');
  d(40, 4, 5, 0x30); d(11, 0, 4, 0); branch(0x40820000, 'drain');
  // Wait for the VI to enter the next 525-line half of its full two-field cycle.
  // This bounds the command producer to one new rendered packet per video field.
  d(40, 7, 9, 0x2c); d(11, 0, 7, 526); branch(0x41800000, 'wait-low');
  label('wait-high');
  d(40, 7, 9, 0x2c); d(11, 0, 7, 526); branch(0x40800000, 'wait-high');
  branch(0x48000000, 'next');
  label('wait-low');
  d(40, 7, 9, 0x2c); d(11, 0, 7, 526); branch(0x41800000, 'wait-low');
  label('next');
  d(27, 10, 10, 1); // xoris r10,r10,1 toggles the FIFO's physical 64KiB bank
  branch(0x48000000, 'submit');
  for (const { index, opcode, target } of branches) {
    const displacement = (labels.get(target) - index) * 4;
    if (!Number.isFinite(displacement) || displacement < -32768 || displacement > 32764) throw new RangeError('GX probe branch is out of range.');
    words[index] = (opcode | (displacement & (opcode >>> 26 === 18 ? 0x03fffffc : 0xfffc))) >>> 0;
  }
  while (words.length % 8) emit(0x60000000);
  const textSize = words.length * 4;
  const dataOffset = 0x100 + textSize;
  const bytes = Buffer.alloc(dataOffset + FIFO_SIZE + commandBytes);
  bytes.writeUInt32BE(0x100, 0); bytes.writeUInt32BE(ENTRY, 0x48); bytes.writeUInt32BE(textSize, 0x90);
  bytes.writeUInt32BE(dataOffset, 0x1c); bytes.writeUInt32BE(0x80000000 + FIFO_A, 0x64);
  bytes.writeUInt32BE(FIFO_SIZE + commandBytes, 0xac); bytes.writeUInt32BE(ENTRY, 0xe0);
  words.forEach((word, i) => bytes.writeUInt32BE(word, 0x100 + i * 4));
  streams[0].copy(bytes, dataOffset); streams[1].copy(bytes, dataOffset + FIFO_SIZE);
  return {
    bytes, fileName: 'wiiclipse-gx-probe.dol', width: WIDTH, height: HEIGHT,
    commandBytes, trianglesPerFrame: layers + 2,
    samples: [
      { x: 32, y: 32, r: 0, g: 0, b: 128 },
      { x: 320, y: 120, r: 255, g: 0, b: 0 },
      { x: 320, y: 300, r: 127, g: 0, b: 128 },
    ],
    alternateSamples: [
      { x: 32, y: 32, r: 0, g: 0, b: 128 },
      { x: 320, y: 120, r: 0, g: 255, b: 0 },
      { x: 320, y: 300, r: 0, g: 127, b: 128 },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node native/tests/gx-boot-probe.mjs <output.dol> [layers]');
  const probe = createGxBootProbe({ layers: process.argv[3] === undefined ? 8 : Number(process.argv[3]) });
  await writeFile(process.argv[2], probe.bytes);
  console.log(`Generated original GX workload: ${probe.bytes.length} bytes, ${probe.trianglesPerFrame} triangles/field.`);
}
