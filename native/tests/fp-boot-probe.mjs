// SPDX-License-Identifier: GPL-2.0-or-later
// Original executable: no game, SDK, firmware, assembler or shipped image.
// Eight exact FP results must reach RAM and pass integer comparisons before
// the visible red sample turns white. The arithmetic then repeats continuously.
import { createBootProbe } from './boot-probe.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createFloatingPointProbe() {
  const bootstrap = createBootProbe();
  const words = Array.from({ length: bootstrap.bytes.readUInt32BE(0x90) / 4 },
    (_, i) => bootstrap.bytes.readUInt32BE(0x100 + i * 4));
  const idle = words.lastIndexOf(0x48000000);
  if (idle < 0) throw new Error('Original framebuffer bootstrap has no idle exit');
  const start = words.length;
  words[idle] = (0x48000000 | ((start - idle) * 4)) >>> 0;
  const emit = word => { words.push(word >>> 0); return words.length - 1; };
  const d = (op, reg, base, immediate) => emit((op << 26) | (reg << 21) | (base << 16) | (immediate & 0xffff));
  const li = (reg, value) => d(14, reg, 0, value);
  const load32 = (reg, value) => { d(15, reg, 0, value >>> 16); d(24, reg, reg, value); };
  const branch = (opcode, target) => emit(opcode | (((target - words.length) * 4) & ((opcode >>> 26) === 18 ? 0x03fffffc : 0xfffc)));
  const floatA = (dst, a, b, c, sub) => (63 << 26) | (dst << 21) | (a << 16) | (b << 11) | (c << 6) | (sub << 1);
  const floatX = (dst, b, sub) => (63 << 26) | (dst << 21) | (b << 11) | (sub << 1);
  emit(0x7d6000a6); // mfmsr r11
  d(24, 11, 11, 0x2000); // ori r11,r11,MSR.FP
  emit(0x7d600124); // mtmsr r11
  emit(0x4c00012c); // isync
  load32(12, 0x80400000); // ordinary cached scratch RAM at physical0x00400000
  for (const [offset, high] of [[0, 0x3ff80000], [8, 0x40000000]]) {
    load32(11, high); d(36, 11, 12, offset); li(11, 0); d(36, 11, 12, offset + 4);
  }
  const markerAddress = 0xc01258a0; // XFB (x80,y120), one YUYV word
  load32(13, markerAddress); li(8, 0);
  const loopWord = words.length;
  d(50, 1, 12, 0); d(50, 2, 12, 8); // lfd f1=1.5,f2=2
  const expected = [
    { word: floatA(3, 1, 2, 0, 21) >>> 0, bits: '400c000000000000' }, // fadd3.5
    { word: floatA(4, 2, 1, 0, 20) >>> 0, bits: '3fe0000000000000' }, // fsub0.5
    { word: floatA(5, 1, 0, 2, 25) >>> 0, bits: '4008000000000000' }, // fmul3
    { word: floatA(6, 5, 2, 0, 18) >>> 0, bits: '3ff8000000000000' }, // fdiv1.5
    { word: floatX(7, 6, 72) >>> 0, bits: '3ff8000000000000' }, // fmr1.5
    { word: floatX(8, 3, 12) >>> 0, bits: '400c000000000000' }, // frsp3.5
    { word: floatX(9, 4, 40) >>> 0, bits: 'bfe0000000000000' }, // fneg-0.5
    { word: floatX(10, 9, 264) >>> 0, bits: '3fe0000000000000' }, // fabs0.5
  ];
  expected.forEach(({ word }) => emit(word));
  const failBranches = [];
  expected.forEach(({ bits }, index) => {
    const offset = 64 + index * 8;
    d(54, index + 3, 12, offset); // stfd both halves of the actual result
    d(32, 14, 12, offset); load32(15, Number.parseInt(bits.slice(0, 8), 16));
    emit((31 << 26) | (14 << 16) | (15 << 11)); // cmpw r14,r15
    failBranches.push(emit(0x40820000));
    emit(floatX(0, 0, 72)); // fmr f0,f0: this low-word block also requires FPU
    d(32, 14, 12, offset + 4); d(11, 0, 14, 0); // cmpwi low32,0
    failBranches.push(emit(0x40820000));
  });
  emit(floatX(0, 0, 72)); // success/branch block cannot be an integer-only promotion
  load32(11, 0xeb80eb80); d(36, 11, 13, 0); // visible success becomes white
  d(14, 8, 8, 1); d(36, 8, 12, 128); // observable monotonically advancing FP loop
  emit(0x7c0004ac); branch(0x48000000, loopWord);
  const failureWord = words.length;
  load32(11, 0x515a51f0); d(36, 11, 13, 0); // any wrong result stays red
  emit(0x7c0004ac); emit(0x48000000);
  for (const index of failBranches) words[index] |= ((failureWord - index) * 4) & 0xfffc;
  while (words.length % 8) emit(0x60000000);
  const bytes = Buffer.alloc(0x100 + words.length * 4);
  bootstrap.bytes.copy(bytes, 0, 0, 0x100);
  bytes.writeUInt32BE(words.length * 4, 0x90);
  words.forEach((word, index) => bytes.writeUInt32BE(word >>> 0, 0x100 + index * 4));
  return { ...bootstrap, bytes, fileName: 'wiiclipse-fp-probe.dol',
    samples: bootstrap.samples.map((sample, index) => index ? sample : { ...sample, r: 255, g: 255, b: 255 }),
    floatingPoint: { markerAddress, loopWord, failureWord, expected } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node native/tests/fp-boot-probe.mjs <output.dol>');
  const probe = createFloatingPointProbe(); await writeFile(process.argv[2], probe.bytes);
  console.log(`Generated ${probe.bytes.length}-byte original FP compute probe`);
}
