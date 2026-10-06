// SPDX-License-Identifier: GPL-2.0-or-later
// Original video probes: no SDK, ROM, game data, assembler, or native core required to generate.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function createFrameProbe(wiiPhysical = false, compute = false) {
  const words = [];
  const emit = (word) => words.push(word >>> 0);
  const d = (op, reg, base, immediate) => emit((op << 26) | (reg << 21) | (base << 16) | (immediate & 0xffff));
  const li = (reg, value) => d(14, reg, 0, value);
  const lis = (reg, value) => d(15, reg, 0, value);
  const load32 = (reg, value) => {
    lis(reg, value >>> 16);
    d(24, reg, reg, value); // ori rD,rS,low16 (source/destination are the same here)
  };
  const branch = (opcode, target) => {
    const displacement = (target - words.length) * 4;
    if (displacement < -32768 || displacement > 32764) throw new RangeError('Probe branch is out of range.');
    emit(opcode | (displacement & ((opcode >>> 26) === 18 ? 0x03fffffc : 0xfffc)));
  };

  // Direct GC executable boot supplies BAT mappings; Wii NAND boot starts in real mode.
  // Write every framebuffer byte with PPC instructions, rather than shipping a bitmap.
  lis(3, wiiPhysical ? 0x0010 : 0xc010); // XFB at physical 0x00100000
  li(7, 240); // row count
  const row = words.length;
  const stripes = [
    { yuyv: 0x515a51f0, r: 255, g: 0, b: 0 },
    { yuyv: 0x91369122, r: 0, g: 255, b: 0 },
    { yuyv: 0x29f0296e, r: 0, g: 0, b: 255 },
    { yuyv: 0xeb80eb80, r: 255, g: 255, b: 255 },
  ];
  if (wiiPhysical) stripes.reverse(); // distinguish a WAD frame from an earlier GC probe frame
  for (const { yuyv } of stripes) {
    // Limited-range BT.601: red, green, blue, white. One word is Y0 Cb Y1 Cr.
    load32(4, yuyv);
    li(6, 80); // 80 pairs = 160 pixels, four stripes per 640-pixel row
    emit(0x7cc903a6); // mtctr r6
    const pair = words.length;
    d(36, 4, 3, 0); // stw r4,0(r3)
    d(14, 3, 3, 4); // addi r3,r3,4
    branch(0x42000000, pair); // bdnz pair
  }
  d(14, 7, 7, -1); // addi r7,r7,-1
  d(11, 0, 7, 0); // cmpwi cr0,r7,0
  branch(0x40820000, row); // bne cr0,row
  emit(0x7c0004ac); // sync: finish uncached framebuffer stores before VI fetches

  load32(5, wiiPhysical ? 0x0c002000 : 0xcc002000); // VI MMIO: real-mode or bootstrap DBAT1
  const vi16 = (offset, value) => { li(4, value); d(44, 4, 5, offset); };
  const vi32 = (offset, value) => { load32(4, value); d(36, 4, 5, offset); };
  vi16(0x02, 0); // temporarily disable display; do not request a reset
  vi16(0x00, 0x0f06); // 240 active lines, six equalization half-lines
  vi32(0x0c, 0x00030018); // odd: PSB=3, PRB=24 -> 525 half-lines
  vi32(0x10, 0x00020019); // even: PSB=2, PRB=25 -> 525 half-lines
  vi16(0x48, 0x2828); // WPL=40, STD=40 -> width640, byte stride1280
  vi16(0x6c, 0); // 27 MHz VI clock (about 59.94 fields/s with bootstrap HLW429)
  vi32(0x1c, 0x00100000); // top XFB, byte address, POFF=0
  vi32(0x24, 0x00100000); // bottom XFB uses the same 240-line image
  vi32(0x30, 0); // mask VI interrupts: this probe needs no interrupt handler
  vi32(0x34, 0);
  vi16(0x02, 5); // enable NTSC, non-interlaced
  emit(0x7c0004ac); // sync
  if (compute) {
    // Keep executing arithmetic and uncached memory operations, so this workload
    // cannot be reduced to Dolphin's idle-loop shortcut. The visible XFB stays intact.
    li(8, 1);
    const outer = words.length;
    lis(9, wiiPhysical ? 0x0020 : 0xc020); // scratch RAM at physical 0x00200000
    li(6, 1024);
    emit(0x7cc903a6); // mtctr r6
    const inner = words.length;
    d(7, 8, 8, 25173); // mulli r8,r8,25173
    d(14, 8, 8, 13849); // addi r8,r8,13849
    emit((21 << 26) | (8 << 21) | (10 << 16) | (5 << 11) | (31 << 1)); // rotlwi r10,r8,5
    emit((31 << 26) | (8 << 21) | (8 << 16) | (10 << 11) | (316 << 1)); // xor r8,r8,r10
    d(36, 8, 9, 0); // stw r8,0(r9)
    d(32, 10, 9, 0); // lwz r10,0(r9)
    emit((31 << 26) | (8 << 21) | (8 << 16) | (10 << 11) | (266 << 1)); // add r8,r8,r10
    d(14, 9, 9, 4); // addi r9,r9,4
    branch(0x42000000, inner); // bdnz inner
    branch(0x48000000, outer); // refill scratch ring forever, without an idle branch
  } else {
    emit(0x48000000); // b .; CoreTiming/VI continues to scan out the framebuffer
  }

  // Dolphin requires all DOL text/data section addresses and sizes to align to 32 bytes.
  while (words.length % 8) emit(0x60000000); // unreachable nop padding
  const bytes = Buffer.alloc(0x100 + words.length * 4);
  bytes.writeUInt32BE(0x100, 0x00); // text section 0: file offset
  const entry = wiiPhysical ? 0x3400 : 0x80003100;
  bytes.writeUInt32BE(entry, 0x48); // Wii IOS releases PPC at physical 0x3400
  bytes.writeUInt32BE(words.length * 4, 0x90); // text section 0: length
  bytes.writeUInt32BE(entry, 0xe0); // entry point
  words.forEach((word, index) => bytes.writeUInt32BE(word, 0x100 + index * 4));
  return {
    bytes,
    fileName: compute ? 'wiiclipse-compute-probe.dol' :
      (wiiPhysical ? 'wiiclipse-wii-boot-probe.dol' : 'wiiclipse-boot-probe.dol'),
    width: 640,
    height: 240,
    samples: stripes.map(({ r, g, b }, index) => ({ x: 80 + index * 160, y: 120, r, g, b })),
  };
}

export function createBootProbe() { return createFrameProbe(); }

export function createComputeProbe() { return createFrameProbe(false, true); }

// This DOL is only for the WAD boot path: loading it as a standalone DOL is not a Wii boot test.
export function createWiiBootDol() { return createFrameProbe(true); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const probe = createBootProbe();
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node native/tests/boot-probe.mjs <output.dol>');
  await writeFile(output, probe.bytes);
  console.log(`Generated ${probe.bytes.length}-byte original GameCube boot probe: ${output}`);
}
