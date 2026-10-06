import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGLRenderer } from '../src/webgl-renderer.js';

function setup(t, { observe = true } = {}) {
  const calls = [];
  const methods = new Map();
  const gl = new Proxy({}, { get(_, name) {
    if (name === name.toUpperCase()) return name;
    if (!methods.has(name)) methods.set(name, (...args) => {
      calls.push({ name, args });
      if (name === 'getUniformLocation') return args[1];
      return name === 'getShaderParameter' || name === 'getProgramParameter' ? true : {};
    });
    return methods.get(name);
  } });
  let layoutReads = 0;
  let cssWidth = 320;
  let cssHeight = 240;
  let resized;
  const canvas = {
    width: 300, height: 150,
    get clientWidth() { layoutReads++; return cssWidth; },
    get clientHeight() { layoutReads++; return cssHeight; },
    getContext: () => gl,
  };
  for (const [key, value] of Object.entries({
    devicePixelRatio: 1,
    ResizeObserver: observe ? class {
      constructor(callback) { resized = callback; }
      observe(target) { assert.equal(target, canvas); }
    } : undefined,
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const renderer = new WebGLRenderer(canvas);
  return {
    renderer, canvas, calls,
    of: name => calls.filter(call => call.name === name),
    get layoutReads() { return layoutReads; },
    cssSize(w, h) { cssWidth = w; cssHeight = h; resized?.([]); },
  };
}

const frame = (width = 2, height = 2, pitch = width * 4) => ({
  width, height, pitch, buffer: new ArrayBuffer(pitch * height),
});

test('same-size frames update texture storage instead of redefining it', t => {
  const h = setup(t);
  h.renderer.presentXRGB8888(frame());
  h.renderer.presentXRGB8888(frame());
  h.renderer.presentXRGB8888(frame(3, 2));
  h.renderer.presentXRGB8888(frame(3, 2));
  assert.equal(h.of('texImage2D').length, 2, 'Allocate only when frame dimensions change');
  assert.equal(h.of('texSubImage2D').length, 2);
  assert.deepEqual(h.of('texImage2D').map(({ args }) => args.slice(3, 5)), [[2, 2], [3, 2]]);
  assert.equal(h.of('drawArrays').length, 4);
});

test('pixel-aligned pitch uploads the original buffer and resets row length for tight frames', t => {
  const h = setup(t);
  const padded = frame(2, 2, 12);
  h.renderer.presentXRGB8888(padded);
  const first = h.of('texImage2D')[0];
  assert.equal(first.args.at(-1).buffer, padded.buffer, 'No full-frame staging copy');
  h.renderer.presentXRGB8888(frame());
  assert.deepEqual(h.of('pixelStorei').filter(({ args }) => args[0] === 'UNPACK_ROW_LENGTH')
    .map(({ args }) => args[1]), [3, 0]);
});

test('unaligned byte pitch keeps correct rows and reuses its staging allocation', t => {
  const h = setup(t);
  const padded = frame(1, 2, 5);
  new Uint8Array(padded.buffer).set([1, 2, 3, 0, 99, 4, 5, 6, 0, 99]);
  h.renderer.presentXRGB8888(padded);
  const firstPixels = h.of('texImage2D')[0].args.at(-1);
  assert.deepEqual([...firstPixels], [1, 2, 3, 0, 4, 5, 6, 0]);
  h.renderer.presentXRGB8888(padded);
  const last = h.calls.filter(({ name }) => name === 'texImage2D' || name === 'texSubImage2D').at(-1);
  assert.equal(last.args.at(-1).buffer, firstPixels.buffer, 'Reuse exceptional unaligned-pitch storage');
});

test('RGBA packets switch channel interpretation while untagged legacy frames remain XRGB', t => {
  const h = setup(t);
  h.renderer.presentXRGB8888(frame());
  h.renderer.presentXRGB8888({ ...frame(), pixelFormat: 'RGBA8888' });
  h.renderer.presentXRGB8888({ ...frame(), pixelFormat: 'RGBA8888' });
  h.renderer.presentXRGB8888(frame());
  h.renderer.presentXRGB8888({ ...frame(), pixelFormat: 'RGBA8888' });
  assert.deepEqual(h.of('uniform1i').filter(({ args }) => args[0] === 'uRGBA')
    .map(({ args }) => args[1]), [1, 0, 1]);
  assert.equal(h.of('texImage2D').length, 1, 'Changing channel format does not recreate texture storage');
});

test('steady frames avoid layout reads and redundant viewport updates', t => {
  const h = setup(t);
  const initialReads = h.layoutReads;
  for (let i = 0; i < 10; i++) h.renderer.presentXRGB8888(frame());
  assert.equal(h.layoutReads, initialReads);
  assert.equal(h.of('viewport').length, 1);
  h.renderer.clear();
  assert.equal(h.of('viewport').length, 1);
});

test('observed CSS size and DPR changes resize the next frame, capped at 2x', t => {
  const h = setup(t);
  h.cssSize(400, 300);
  h.renderer.presentXRGB8888(frame());
  assert.deepEqual([h.canvas.width, h.canvas.height], [400, 300]);
  globalThis.devicePixelRatio = 1.5;
  h.renderer.presentXRGB8888(frame());
  assert.deepEqual([h.canvas.width, h.canvas.height], [600, 450]);
  globalThis.devicePixelRatio = 3;
  h.renderer.presentXRGB8888(frame());
  assert.deepEqual(h.of('viewport').at(-1).args, [0, 0, 800, 600]);
  assert.equal(h.of('texImage2D').length, 1, 'Canvas resizing does not reallocate source texture');
});

test('explicit resize and browsers without ResizeObserver still follow CSS changes', t => {
  const h = setup(t, { observe: false });
  h.cssSize(500, 250);
  h.renderer.presentXRGB8888(frame());
  assert.deepEqual([h.canvas.width, h.canvas.height], [500, 250]);
  h.cssSize(120, 90);
  h.renderer.resize();
  assert.deepEqual([h.canvas.width, h.canvas.height], [120, 90]);
});
