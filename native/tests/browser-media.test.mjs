import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBootProbe, createComputeProbe } from './boot-probe.mjs';

const host = readFileSync(new URL('../BrowserHost.cpp', import.meta.url), 'utf8');
function emJs(name, parameters, heap, globals = {}) {
  const body = host.match(new RegExp(`EM_JS\\([^,]+, ${name}, [\\s\\S]*?\\), \\{([\\s\\S]*?)\\n\\}\\);`))?.[1];
  assert.ok(body, `Actual ${name} EM_JS implementation must be present`);
  const messages = [];
  const invoke = new Function('HEAPU8', 'HEAP16', 'self', ...Object.keys(globals), ...parameters, body);
  return {
    messages,
    call: (...args) => invoke(heap, new Int16Array(heap.buffer), {
      postMessage: (packet, transfer) => messages.push({ packet, transfer }),
    }, ...Object.values(globals), ...args),
  };
}

function graphicsContext() {
  const constants = ['READ_FRAMEBUFFER', 'READ_FRAMEBUFFER_BINDING', 'PIXEL_PACK_BUFFER',
    'PIXEL_PACK_BUFFER_BINDING', 'PACK_ALIGNMENT', 'PACK_ROW_LENGTH', 'PACK_SKIP_ROWS',
    'PACK_SKIP_PIXELS', 'RGBA', 'UNSIGNED_BYTE'];
  const gl = Object.fromEntries(constants.map((name, i) => [name, i + 1]));
  const original = new Map([[gl.READ_FRAMEBUFFER_BINDING, { framebuffer: 'Dolphin read target' }],
    [gl.PIXEL_PACK_BUFFER_BINDING, { buffer: 'Dolphin staging buffer' }],
    [gl.PACK_ALIGNMENT, 8], [gl.PACK_ROW_LENGTH, 1024], [gl.PACK_SKIP_ROWS, 7], [gl.PACK_SKIP_PIXELS, 3]]);
  const state = new Map(original);
  let reads = 0;
  gl.getParameter = key => state.get(key);
  gl.bindFramebuffer = (target, framebuffer) => {
    assert.equal(target, gl.READ_FRAMEBUFFER);
    state.set(gl.READ_FRAMEBUFFER_BINDING, framebuffer);
  };
  gl.bindBuffer = (target, buffer) => {
    assert.equal(target, gl.PIXEL_PACK_BUFFER);
    state.set(gl.PIXEL_PACK_BUFFER_BINDING, buffer);
  };
  gl.pixelStorei = (key, value) => { assert.ok(state.has(key)); state.set(key, value); };
  gl.readPixels = (x, y, width, height, format, type, pixels) => {
    reads++;
    assert.deepEqual([x, y, format, type], [0, 0, gl.RGBA, gl.UNSIGNED_BYTE]);
    assert.equal(state.get(gl.READ_FRAMEBUFFER_BINDING), null);
    assert.equal(state.get(gl.PIXEL_PACK_BUFFER_BINDING), null);
    assert.equal(state.get(gl.PACK_ALIGNMENT), 1);
    for (const key of [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_ROWS, gl.PACK_SKIP_PIXELS]) assert.equal(state.get(key), 0);
    assert.equal(pixels.length, width * height * 4);
    // Distinct channels and rows expose both accidental swizzling and incomplete flips.
    for (let i = 0; i < pixels.length; i++) pixels[i] = i + 1;
  };
  return { gl, state, original, reads: () => reads };
}

test('actual hardware host boundary flips GL rows, preserves RGBA, and restores Dolphin pack state', () => {
  for (const height of [1, 2, 3]) {
    const context = graphicsContext();
    const hardware = emJs('WebPostHardwareVideo', ['width', 'height'], new Uint8Array(0),
      { GL: { currentContext: { GLctx: context.gl } } });
    hardware.call(2, height);
    assert.equal(context.reads(), 1);
    assert.deepEqual(context.state, context.original, 'all touched framebuffer/PBO/pixel-store state restored');
    assert.equal(hardware.messages.length, 1);
    const { packet, transfer } = hardware.messages[0];
    assert.equal(packet.pixelFormat, 'RGBA8888');
    assert.deepEqual([packet.width, packet.height, packet.pitch], [2, height, 8]);
    const expected = [];
    for (let row = height - 1; row >= 0; row--) for (let byte = 0; byte < 8; byte++) expected.push(row * 8 + byte + 1);
    assert.deepEqual([...new Uint8Array(packet.buffer)], expected);
    assert.deepEqual(transfer, [packet.buffer]);
  }
});

test('actual hardware host boundary rejects missing context and frames outside its backing surface', () => {
  const context = graphicsContext();
  const GL = { currentContext: { GLctx: context.gl } };
  const hardware = emJs('WebPostHardwareVideo', ['width', 'height'], new Uint8Array(0), { GL });
  for (const [width, height] of [[0, 480], [640, 0], [641, 480], [640, 577]]) hardware.call(width, height);
  GL.currentContext = null;
  hardware.call(640, 480);
  assert.equal(context.reads(), 0);
  assert.equal(hardware.messages.length, 0);
  assert.deepEqual(context.state, context.original);
});

test('actual RGBA host boundary packs cropped rows without changing channels or sharing heap storage', () => {
  const heap = new Uint8Array(64);
  for (let i = 0; i < heap.length; ++i) heap[i] = i;
  const rgba = emJs('WebPostRGBA', ['data', 'width', 'height', 'pitch'], heap);
  rgba.call(8, 2, 2, 12);
  const { packet, transfer } = rgba.messages[0];
  assert.equal(packet.pixelFormat, 'RGBA8888');
  assert.equal(packet.pitch, 8);
  assert.equal(packet.width, 2);
  assert.equal(packet.height, 2);
  assert.deepEqual([...new Uint8Array(packet.buffer)], [...heap.slice(8, 16), ...heap.slice(20, 28)]);
  assert.equal(transfer[0], packet.buffer);
  assert.notEqual(packet.buffer, heap.buffer);
  heap.fill(0);
  assert.equal(new Uint8Array(packet.buffer)[0], 8);
  rgba.call(8, 2, 2, 4);
  assert.equal(rgba.messages.length, 1, 'invalid pitch must not produce a frame');
});

test('actual RGBA host boundary copies a contiguous image once into its transferable buffer', () => {
  const heap = new Uint8Array(64).fill(137);
  const rgba = emJs('WebPostRGBA', ['data', 'width', 'height', 'pitch'], heap);
  rgba.call(8, 3, 2, 12);
  assert.deepEqual([...new Uint8Array(rgba.messages[0].packet.buffer)], new Array(24).fill(137));
});

test('actual audio host boundary preserves signed stereo samples and the core sample rate', () => {
  const heap = new Uint8Array(64);
  new Int16Array(heap.buffer).set([-32768, 32767, -111, 222, -333, 444], 2);
  const audio = emJs('WebPostAudio', ['data', 'frames', 'sample_rate'], heap);
  assert.equal(audio.call(4, 3, 32029), 3);
  assert.equal(audio.messages[0].packet.sampleRate, 32029);
  assert.equal(audio.messages[0].packet.frames, 3);
  assert.deepEqual([...new Int16Array(audio.messages[0].packet.buffer)], [-32768, 32767, -111, 222, -333, 444]);
});

test('compute DOL preserves visible checks and runs a bounded memory loop without an idle branch', () => {
  const probe = createComputeProbe();
  assert.deepEqual(probe.samples, createBootProbe().samples);
  assert.equal(probe.bytes.readUInt32BE(0x90) % 32, 0);
  const words = Array.from({ length: (probe.bytes.length - 0x100) / 4 }, (_, i) => probe.bytes.readUInt32BE(0x100 + i * 4));
  assert.ok(!words.includes(0x48000000));
  assert.ok(words.includes(0x3d20c020), 'scratch ring starts at uncached physical 2 MiB');
  assert.ok(words.includes(0x38c00400), 'scratch ring has 1,024 words');
  for (let i = 0; i < words.length; ++i) {
    const op = words[i] >>> 26;
    if (op !== 16 && op !== 18) continue;
    const displacement = op === 18 ? (words[i] << 6) >> 6 : (words[i] << 16) >> 16;
    const target = i + displacement / 4;
    assert.ok(Number.isInteger(target) && target >= 0 && target < words.length, `branch ${i} stays in code`);
  }
});
