// SPDX-License-Identifier: GPL-2.0-or-later
// Original unsigned test channel for Dolphin's existing HLE WAD import/boot path.
import { createCipheriv, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWiiBootDol } from './boot-probe.mjs';

// Format interoperability constant from pinned Dolphin Core/IOS/IOSC.cpp, LoadDefaultEntries.
const commonKey = Buffer.from('ebe42a225e8593e448d9c5457381aaf7', 'hex');
const titleKey = Buffer.from('WiiClipseProbe01', 'ascii'); // original deterministic 16-byte test key
const titleId = 0x0001000157435045n; // channel namespace, "WCPE" (WiiClipse Probe, NTSC-U)
const align64 = size => Math.ceil(size / 64) * 64;

function encrypt(key, iv, plaintext) {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function unsignedBlob(size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(0x00010001, 0); // RSA-2048 layout, deliberately zero signature bytes
  bytes.write('WiiClipse-Original-Test', 0x140, 'ascii'); // descriptive synthetic issuer, not Nintendo
  return bytes;
}

export function createWadBootProbe() {
  const dol = createWiiBootDol();
  const titleIv = Buffer.alloc(16);
  titleIv.writeBigUInt64BE(titleId);

  // ES/Formats.h Ticket (0x2a4 bytes), version 0 and unpersonalised device ID 0.
  const ticket = unsignedBlob(0x2a4);
  encrypt(commonKey, titleIv, titleKey).copy(ticket, 0x1bf);
  ticket.writeBigUInt64BE(1n, 0x1d0); // original ticket ID
  ticket.writeBigUInt64BE(titleId, 0x1dc);
  ticket[0x1f1] = 0; // common key index
  ticket[0x222] = 0x80; // permission for content index 0

  // One normal content: the original DOL, not a banner or an installed IOS image.
  const tmd = unsignedBlob(0x1e4 + 36);
  tmd.writeBigUInt64BE(0x0000000100000024n, 0x184); // IOS36, implemented by Dolphin HLE
  tmd.writeBigUInt64BE(titleId, 0x18c);
  tmd.writeUInt32BE(1, 0x194); // normal title flags
  tmd.writeUInt16BE(0x5743, 0x198); // original group "WC"
  tmd.writeUInt16BE(1, 0x19c); // NTSC-U
  tmd.writeUInt16BE(1, 0x1dc); // title version
  tmd.writeUInt16BE(1, 0x1de); // number of contents
  tmd.writeUInt16BE(0, 0x1e0); // boot content index
  tmd.writeUInt32BE(0, 0x1e4); // content ID
  tmd.writeUInt16BE(0, 0x1e8); // content index
  tmd.writeUInt16BE(1, 0x1ea); // normal, non-shared content
  tmd.writeBigUInt64BE(BigInt(dol.bytes.length), 0x1ec);
  createHash('sha1').update(dol.bytes).digest().copy(tmd, 0x1f4);

  // Content IV is its big-endian 16-bit index followed by fourteen zero bytes.
  // With index 0 this is all zero. SHA-1 above excludes the 64-byte-aligned padding.
  const plaintext = Buffer.alloc(align64(dol.bytes.length));
  dol.bytes.copy(plaintext);
  const content = encrypt(titleKey, Buffer.alloc(16), plaintext);

  const ticketOffset = 0x40; // header padded to 64, no certificate chain
  const tmdOffset = ticketOffset + align64(ticket.length);
  const dataOffset = tmdOffset + align64(tmd.length);
  const bytes = Buffer.alloc(dataOffset + content.length);
  bytes.writeUInt32BE(0x20, 0); // header length
  bytes.writeUInt16BE(0x4973, 4); // installable WAD magic "Is"
  bytes.writeUInt32BE(ticket.length, 0x10);
  bytes.writeUInt32BE(tmd.length, 0x14);
  bytes.writeUInt32BE(content.length, 0x18);
  ticket.copy(bytes, ticketOffset);
  tmd.copy(bytes, tmdOffset);
  content.copy(bytes, dataOffset);
  return { ...dol, bytes, fileName: 'wiiclipse-wad-boot-probe.wad', titleId: titleId.toString(16).padStart(16, '0') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node native/tests/wad-boot-probe.mjs <output.wad>');
  const probe = createWadBootProbe();
  await writeFile(output, probe.bytes);
  console.log(`Generated ${probe.bytes.length}-byte original Wii WAD boot probe: ${output}`);
}
