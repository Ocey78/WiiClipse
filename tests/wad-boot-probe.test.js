import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { createWadBootProbe } from '../native/tests/wad-boot-probe.mjs';
import { createBootProbe } from '../native/tests/boot-probe.mjs';

const align64 = size => Math.ceil(size / 64) * 64;

function readWad() {
  const probe = createWadBootProbe();
  const bytes = Buffer.from(probe.bytes);
  const ticketOffset = align64(bytes.readUInt32BE(0)) + align64(bytes.readUInt32BE(8));
  const ticketSize = bytes.readUInt32BE(0x10);
  const tmdOffset = ticketOffset + align64(ticketSize);
  const tmdSize = bytes.readUInt32BE(0x14);
  const dataOffset = tmdOffset + align64(tmdSize);
  return { probe, bytes, ticketOffset, tmdOffset, dataOffset,
    ticket: bytes.subarray(ticketOffset, ticketOffset + ticketSize),
    tmd: bytes.subarray(tmdOffset, tmdOffset + tmdSize),
    content: bytes.subarray(dataOffset, dataOffset + bytes.readUInt32BE(0x18)),
  };
}

function decrypt(key, iv, bytes) {
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}

function decryptContent(wad) {
  // Independently read the ticket/content IVs as the pinned Dolphin readers do.
  const titleIv = Buffer.alloc(16);
  wad.ticket.copy(titleIv, 0, 0x1dc, 0x1e4);
  const key = decrypt(Buffer.from('ebe42a225e8593e448d9c5457381aaf7', 'hex'), titleIv,
    wad.ticket.subarray(0x1bf, 0x1cf));
  const contentIv = Buffer.alloc(16);
  contentIv.writeUInt16BE(wad.tmd.readUInt16BE(0x1e8), 0);
  return decrypt(key, contentIv, wad.content);
}

test('original WAD has a complete aligned channel package with one bootable IOS36 content', () => {
  const { probe, bytes, ticket, tmd, ticketOffset, tmdOffset, dataOffset } = readWad();
  assert.equal(probe.fileName, 'wiiclipse-wad-boot-probe.wad');
  assert.equal(bytes.readUInt32BE(0), 0x20);
  assert.equal(bytes.readUInt32BE(2), 0x00204973, 'Dolphin WAD identification magic');
  assert.equal(bytes.readUInt32BE(8), 0, 'No copied certificate chain');
  assert.equal(bytes.readUInt32BE(0x1c), 0, 'No copied channel banner');
  assert.equal(ticket.length, 0x2a4);
  assert.equal(tmd.length, 0x1e4 + 36);
  for (const offset of [ticketOffset, tmdOffset, dataOffset]) assert.equal(offset % 64, 0);
  assert.equal(bytes.length, dataOffset + align64(bytes.readUInt32BE(0x18)));
  assert.equal(ticket.readUInt32BE(0), 0x10001);
  assert.equal(tmd.readUInt32BE(0), 0x10001);
  for (const signed of [ticket, tmd]) assert.ok(signed.subarray(4, 0x104).every(byte => byte === 0), 'Test is deliberately unsigned');
  assert.equal(ticket[0x1bc], 0, 'Version-0 ticket');
  assert.equal(ticket.readUInt32BE(0x1d8), 0, 'Ticket is not tied to a console');
  assert.equal(ticket[0x1f1], 0, 'Retail common-key index');
  assert.equal(tmd.readBigUInt64BE(0x184), 0x0000000100000024n);
  assert.equal(tmd.readBigUInt64BE(0x18c), 0x0001000157435045n);
  assert.equal(ticket.readBigUInt64BE(0x1dc), tmd.readBigUInt64BE(0x18c));
  assert.equal(probe.titleId, '0001000157435045');
  assert.equal(tmd.readUInt32BE(0x194), 1);
  assert.equal(tmd.readUInt16BE(0x19c), 1, 'NTSC-U timing');
  assert.equal(tmd.readUInt16BE(0x1de), 1);
  assert.equal(tmd.readUInt16BE(0x1e0), 0);
  assert.equal(tmd.readUInt32BE(0x1e4), 0);
  assert.equal(tmd.readUInt16BE(0x1e8), 0);
  assert.equal(tmd.readUInt16BE(0x1ea), 1, 'Normal non-shared content');
});

test('ticket key decrypts the exact content digest and only an original physical-address DOL', () => {
  const wad = readWad();
  const plaintext = decryptContent(wad);
  const contentSize = Number(wad.tmd.readBigUInt64BE(0x1ec));
  const dol = plaintext.subarray(0, contentSize);
  assert.deepEqual(createHash('sha1').update(dol).digest(), wad.tmd.subarray(0x1f4, 0x208));
  assert.ok(plaintext.subarray(contentSize).every(byte => byte === 0), 'Content padding is zero, not PKCS#7');
  assert.equal(wad.content.length, align64(contentSize));
  assert.equal(dol.readUInt32BE(0), 0x100);
  assert.equal(dol.readUInt32BE(0x48), 0x3400, 'IOS starts NAND titles at physical 0x3400');
  assert.equal(dol.readUInt32BE(0xe0), 0x3400);
  assert.equal(dol.readUInt32BE(0x90), dol.length - 0x100);
  assert.equal(dol.readUInt32BE(0x90) % 32, 0);
  assert.equal(dol.readUInt32BE(0x100), 0x3c600010, 'lis r3,0x0010 writes physical XFB RAM');
  const words = Array.from({ length: (dol.length - 0x100) / 4 }, (_, i) => dol.readUInt32BE(0x100 + i * 4));
  assert.ok(words.includes(0x3ca00c00), 'lis r5,0x0c00 selects physical VI MMIO');
  assert.ok(words.includes(0x60a52000), 'ori r5,r5,0x2000 selects VI registers');
  assert.ok(!words.includes(0x3ca0cc00), 'No translated GameCube VI address');
  assert.ok(words.includes(0x48000000), 'PPC loops while the VI scans the written image');
  for (let offset = 0x1c; offset < 0x48; offset += 4) assert.equal(dol.readUInt32BE(offset), 0, 'No bitmap/data section');
});

test('WAD generation is reproducible and its expected frame differs from the GameCube probe', () => {
  const probe = createWadBootProbe();
  assert.deepEqual(probe.bytes, createWadBootProbe().bytes);
  assert.equal(probe.width, 640);
  assert.equal(probe.height, 240);
  assert.deepEqual(probe.samples, [
    { x: 80, y: 120, r: 255, g: 255, b: 255 },
    { x: 240, y: 120, r: 0, g: 0, b: 255 },
    { x: 400, y: 120, r: 0, g: 255, b: 0 },
    { x: 560, y: 120, r: 255, g: 0, b: 0 },
  ]);
  assert.notDeepEqual(probe.samples, createBootProbe().samples, 'Stale GameCube pixels must not pass a WAD boot test');
});
