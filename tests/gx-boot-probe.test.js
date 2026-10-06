import test from 'node:test';
import assert from 'node:assert/strict';
import { createGxBootProbe } from '../native/tests/gx-boot-probe.mjs';

function commandStreams(probe) {
  const dol = Buffer.from(probe.bytes);
  const data = dol.subarray(dol.readUInt32BE(0x1c));
  return [data.subarray(0, probe.commandBytes), data.subarray(0x10000, 0x10000 + probe.commandBytes)];
}

function decodeCommands(bytes) {
  const commands = [];
  let offset = 0;
  while (offset < bytes.length) {
    const opcode = bytes[offset++];
    if (!opcode) continue;
    if (opcode === 0x61) {
      commands.push({ type: 'bp', address: bytes[offset], value: bytes.readUInt32BE(offset) & 0xffffff });
      offset += 4;
    } else if (opcode === 0x08) {
      commands.push({ type: 'cp', address: bytes[offset], value: bytes.readUInt32BE(offset + 1) });
      offset += 5;
    } else if (opcode === 0x10) {
      const count = bytes.readUInt16BE(offset) + 1;
      const address = bytes.readUInt16BE(offset + 2);
      offset += 4;
      commands.push({ type: 'xf', address, values: Array.from({ length: count }, (_, i) => bytes.readUInt32BE(offset + i * 4)) });
      offset += count * 4;
    } else if (opcode === 0x90) {
      const count = bytes.readUInt16BE(offset);
      offset += 2;
      const vertices = [];
      for (let i = 0; i < count; i++, offset += 16) {
        vertices.push({ xyz: [0, 4, 8].map(o => bytes.readFloatBE(offset + o)), rgba: [...bytes.subarray(offset + 12, offset + 16)] });
      }
      commands.push({ type: 'triangles', vertices });
    } else {
      assert.fail(`Unexpected GX opcode ${opcode.toString(16)} at ${offset - 1}`);
    }
  }
  assert.equal(offset, bytes.length, 'Every GX command must end inside the aligned FIFO packet');
  return commands;
}

test('GX probe loads code and two aligned command FIFOs without a pre-rendered XFB', () => {
  const probe = createGxBootProbe();
  const dol = Buffer.from(probe.bytes);
  assert.equal(dol.readUInt32BE(0xe0), 0x80003100);
  assert.equal(dol.readUInt32BE(0x48), 0x80003100);
  assert.equal(dol.readUInt32BE(0x64), 0x80200000);
  assert.equal(dol.readUInt32BE(0x90) % 32, 0);
  assert.equal(dol.readUInt32BE(0xac), 0x10000 + probe.commandBytes);
  assert.equal(probe.commandBytes % 32, 0);
  assert.ok(probe.commandBytes < 0x10000);
  assert.equal(dol.readUInt32BE(0x1c) + dol.readUInt32BE(0xac), dol.length);
  assert.equal(dol.readUInt32BE(0x20), 0, 'No second data section may preload the XFB');
  assert.equal(probe.width, 640);
  assert.equal(probe.height, 480);
});

test('GX packets configure direct vertices, transforms, depth, blending, and EFB copy', () => {
  const probe = createGxBootProbe({ layers: 4 });
  for (const commands of commandStreams(probe).map(decodeCommands)) {
    const register = (type, address) => commands.find(c => c.type === type && c.address === address);
    assert.equal(register('cp', 0x50).value, 0x2200, 'Direct XYZ and color0, no indexed arrays');
    assert.equal(register('cp', 0x70).value, 0x16009, 'Float XYZ and RGBA8');
    assert.deepEqual(register('xf', 0).values, [0x3f800000, 0, 0, 0, 0, 0x3f800000, 0, 0, 0, 0, 0x3f800000, 0]);
    assert.equal(register('xf', 0x1020).values.length, 6);
    assert.deepEqual(register('xf', 0x1026).values, [1], 'Orthographic projection');
    assert.equal(register('bp', 0x40).value, 0x17, 'Depth comparison LEQUAL with updates');
    assert.ok(commands.some(c => c.type === 'bp' && c.address === 0x41 && c.value === 0x4b9), 'Source-alpha blending');
    assert.equal(register('bp', 0x4b).value << 5, 0x00100000);
    assert.equal(register('bp', 0x4a).value, (479 << 10) | 639);
    assert.equal(register('bp', 0x4d).value * 32, 1280, 'YUYV row stride');
    assert.ok(commands.some(c => c.type === 'bp' && c.address === 0x52 && (c.value & 0x4000)), 'Only GX copies produce visible XFB pixels');
    assert.equal(commands.filter(c => c.type === 'triangles').reduce((n, c) => n + c.vertices.length / 3, 0), 6);
  }
});

test('alternating geometry colors verify fresh draws and preserve independent depth/blend samples', () => {
  const probe = createGxBootProbe({ layers: 2 });
  const streams = commandStreams(probe).map(decodeCommands);
  const firstDraws = streams.map(commands => commands.find(c => c.type === 'triangles'));
  assert.deepEqual(firstDraws[0].vertices[0].rgba, [255, 0, 0, 255]);
  assert.deepEqual(firstDraws[1].vertices[0].rgba, [0, 255, 0, 255]);
  assert.deepEqual(probe.samples, [
    { x: 600, y: 400, r: 0, g: 0, b: 128 },
    { x: 320, y: 120, r: 255, g: 0, b: 0 },
    { x: 320, y: 300, r: 127, g: 0, b: 128 },
  ]);
  assert.deepEqual(probe.alternateSamples[1], { x: 320, y: 120, r: 0, g: 255, b: 0 });
  assert.deepEqual(probe.alternateSamples[2], { x: 320, y: 300, r: 0, g: 127, b: 128 });
  for (const commands of streams) {
    const draws = commands.filter(c => c.type === 'triangles');
    assert.equal(draws[0].vertices[0].xyz[2], -0.5);
    assert.equal(draws[1].vertices[0].xyz[2], -0.25, 'Later opaque triangle is farther away and must fail depth');
    assert.equal(draws[2].vertices[0].xyz[2], -0.75, 'Blended triangle is nearer');
    assert.equal(draws[2].vertices[0].rgba[3], 128);
  }
  assert.throws(() => createGxBootProbe({ layers: 0 }), /layers/);
  assert.throws(() => createGxBootProbe({ layers: 1024 }), /layers/);
});

test('samples remain in distinct geometry regions at native and resized output dimensions', () => {
  const probe = createGxBootProbe({ layers: 1 });
  const draws = decodeCommands(commandStreams(probe)[0]).filter(c => c.type === 'triangles');
  const triangle = draw => draw.vertices.slice(0, 3).map(({ xyz }) => [
    (xyz[0] + 1) * probe.width / 2, (1 - xyz[1]) * probe.height / 2,
  ]);
  const inside = ([x, y], vertices) => {
    const sides = vertices.map(([ax, ay], i) => {
      const [bx, by] = vertices[(i + 1) % 3];
      return (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    });
    return sides.every(v => v > 0) || sides.every(v => v < 0);
  };
  const main = triangle(draws[0]), blend = triangle(draws[2]);
  for (const [width, height] of [[640, 480], [640, 528], [1280, 1056]]) {
    const points = probe.samples.map(({ x, y }) => {
      const px = Math.floor((x + 0.5) * width / probe.width);
      const py = Math.floor((y + 0.5) * height / probe.height);
      return [(px + 0.5) * probe.width / width, (py + 0.5) * probe.height / height];
    });
    assert.equal(inside(points[0], main), false, 'Navy point is outside the drawn triangles');
    assert.ok(points[0][1] > 128, 'Background sample avoids the transient startup OSD');
    assert.equal(inside(points[1], main), true);
    assert.equal(inside(points[1], blend), false, 'Opaque point independently checks rejected farther white');
    assert.equal(inside(points[2], blend), true, 'Nearer blue must blend over the opaque triangle');
    assert.equal(inside([points[1][0], probe.height - points[1][1]], blend), true,
      'Vertically flipped output must fail the opaque-color sample');
  }
});

test('PPC submission loop drains each FIFO and waits for the next field before switching packets', () => {
  // Execute the generated integer/MMIO setup against only CP/VI register reads.
  // This checks branches and addresses independently of the generator helpers;
  // it does not substitute for native rendering of the actual GX packets.
  const { bytes, commandBytes } = createGxBootProbe();
  const registers = new Uint32Array(32);
  const mmio = new Map();
  const submissions = [];
  const beamPositions = [100, 100, 526, 526, 526, 100];
  let beamReads = 0;
  let drainReads = 0;
  let compare = 0;
  let pc = 0x100;
  for (let steps = 0; submissions.length < 3 && steps < 1000; steps++) {
    const word = bytes.readUInt32BE(pc);
    const op = word >>> 26;
    const source = (word >>> 21) & 31;
    const base = (word >>> 16) & 31;
    const immediate = (word << 16) >> 16;
    let next = pc + 4;
    if (op === 14 || op === 15) {
      registers[source] = (base ? registers[base] : 0) + (op === 15 ? immediate << 16 : immediate);
    } else if (op === 24 || op === 27) {
      registers[base] = op === 24 ? registers[source] | (word & 65535) : registers[source] ^ ((word & 65535) << 16);
    } else if (op === 21) {
      const shift = (word >>> 11) & 31;
      const first = (word >>> 6) & 31;
      const last = (word >>> 1) & 31;
      let mask = 0;
      for (let bit = first; bit <= last; bit++) mask |= 1 << (31 - bit);
      registers[base] = ((registers[source] << shift) | (registers[source] >>> (32 - shift))) & mask;
    } else if (op === 36 || op === 44) {
      const address = (registers[base] + immediate) >>> 0;
      assert.ok((address >= 0xcc000000 && address < 0xcc000040) ||
        (address >= 0xcc002000 && address < 0xcc002080), 'CPU writes only CP/VI registers, never XFB pixels');
      const value = op === 44 ? registers[source] & 65535 : registers[source];
      mmio.set(address, value);
      if (address === 0xcc000002 && value === 1) submissions.push({
        base: (mmio.get(0xcc000022) << 16) | mmio.get(0xcc000020),
        read: (mmio.get(0xcc00003a) << 16) | mmio.get(0xcc000038),
        distance: (mmio.get(0xcc000032) << 16) | mmio.get(0xcc000030),
        beamReads, drainReads,
      });
    } else if (op === 40) {
      const address = (registers[base] + immediate) >>> 0;
      if (address === 0xcc000030) { registers[source] = drainReads++ % 2 === 0 ? commandBytes : 0; }
      else if (address === 0xcc00202c) { registers[source] = beamPositions[beamReads++]; }
      else assert.fail(`Unexpected MMIO read ${address.toString(16)}`);
    } else if (op === 11) {
      compare = (registers[base] | 0) - immediate;
    } else if (op === 16) {
      const condition = base === 0 ? compare < 0 : base === 2 ? compare === 0 : assert.fail('Unknown CR field');
      if (source === 12 ? condition : source === 4 ? !condition : assert.fail('Unknown branch condition')) next = pc + (immediate & ~3);
    } else if (op === 18) {
      next = pc + ((word << 6) >> 6 & ~3);
    } else {
      assert.equal(word, 0x7c0004ac, 'Only sync is needed beyond integer and MMIO instructions');
    }
    assert.ok(next >= 0x100 && next < 0x100 + bytes.readUInt32BE(0x90), 'Control flow remains inside DOL text');
    pc = next;
  }
  assert.deepEqual(submissions.map(s => s.base), [0x200000, 0x210000, 0x200000]);
  assert.deepEqual(submissions.map(s => s.read), [0x200000, 0x210000, 0x200000]);
  assert.deepEqual(submissions.map(s => s.distance), [commandBytes, commandBytes, commandBytes]);
  assert.deepEqual(submissions.map(s => s.drainReads), [0, 2, 4], 'Each packet drains before resubmission');
  assert.deepEqual(submissions.map(s => s.beamReads), [0, 3, 6], 'Producer waits for a new video field');
});
