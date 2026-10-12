import test from 'node:test';
import assert from 'node:assert/strict';
import { InputState } from '../src/input-state.js';

import { createInputController } from '../src/input-controller.js';

class Surface extends EventTarget {
  constructor(dataset = {}, tagName = 'DIV') {
    super(); this.dataset = dataset; this.tagName = tagName;
    this.style = {}; this.captured = new Set(); this.knob = { style: {} };
  }
  closest() { return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(this.tagName) || this.isContentEditable ? this : null; }
  querySelector() { return this.knob; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function emit(surface, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
  surface.dispatchEvent(event); return event;
}

function setup() {
  const input = new InputState();
  const document = new Surface(); const window = new Surface();
  const button = new Surface({ button: 'A' }, 'BUTTON');
  const left = new Surface({ stick: 'left' }); const right = new Surface({ stick: 'right' });
  document.querySelectorAll = selector => selector === '[data-button]' ? [button] : [left, right];
  let pads = []; let changes = 0; const labels = []; const frames = new Map(); let nextFrame = 0;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const controller = createInputController({
    input, document, window, navigator: { getGamepads: () => pads },
    onChange: () => changes++, onGamepad: label => labels.push(label)
  });
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)); };
  return { input, document, window, button, left, right, controller, frames, tick, labels,
    setPads: value => { pads = value; }, changes: () => changes };
}

function gamepad(index = 2, overrides = {}) {
  return { id: 'Standard controller', index, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), ...overrides };
}

test('keyboard combines opposing directions and releases face, dpad and C-stick controls', () => {
  const env = setup();
  for (const code of ['KeyW', 'KeyD', 'KeyJ', 'ArrowLeft', 'KeyT', 'KeyQ', 'Space']) emit(env.document, 'keydown', { code });
  assert.deepEqual(env.input.snapshot().axes, { lx: 1, ly: -1, rx: 0, ry: -1, l: 1, r: 0 });
  assert.equal(env.input.snapshot().buttons.A, true);
  assert.equal(env.input.snapshot().buttons.LEFT, true);
  assert.equal(env.input.snapshot().buttons.Z, true);
  emit(env.document, 'keydown', { code: 'KeyA' });
  assert.equal(env.input.snapshot().axes.lx, 0);
  emit(env.document, 'keyup', { code: 'KeyA' });
  assert.equal(env.input.snapshot().axes.lx, 1);
  env.controller.reset();
  assert.equal(env.input.snapshot().axes.ly, 0);
  assert.equal(env.input.snapshot().buttons.A, false);
  env.controller.destroy();
});

test('keyboard leaves focused form controls and browser shortcuts usable', () => {
  const env = setup();
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
    const event = emit(env.document, 'keydown', { code: 'KeyJ', target: new Surface({}, tagName) });
    assert.equal(event.defaultPrevented, false);
    assert.equal(!!env.input.snapshot().buttons.A, false);
  }
  const editable = new Surface(); editable.isContentEditable = true;
  emit(env.document, 'keydown', { code: 'KeyJ', target: editable });
  emit(env.document, 'keydown', { code: 'KeyJ', ctrlKey: true });
  assert.equal(!!env.input.snapshot().buttons.A, false);
  emit(env.document, 'keydown', { code: 'KeyJ' });
  emit(env.document, 'keyup', { code: 'KeyJ', target: editable });
  assert.equal(env.input.snapshot().buttons.A, false);
  env.controller.destroy();
});

test('touch captures multiple button pointers and preserves other held sources on release', () => {
  const env = setup();
  emit(env.document, 'keydown', { code: 'KeyJ' });
  emit(env.button, 'pointerdown', { pointerId: 1, button: 0 });
  emit(env.button, 'pointerdown', { pointerId: 2, button: 0 });
  assert.equal(env.button.captured.has(1), true);
  assert.equal(env.button.captured.has(2), true);
  emit(env.document, 'keyup', { code: 'KeyJ' });
  emit(env.button, 'pointerup', { pointerId: 1 });
  assert.equal(env.input.snapshot().buttons.A, true);
  emit(env.button, 'lostpointercapture', { pointerId: 2 });
  assert.equal(env.input.snapshot().buttons.A, false);
  env.controller.destroy();
});

test('dual touch sticks clamp motion and release independently on pointer cancellation', () => {
  const env = setup();
  emit(env.left, 'pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 50 });
  emit(env.right, 'pointerdown', { pointerId: 2, button: 0, clientX: 50, clientY: 0 });
  assert.equal(env.input.snapshot().axes.lx, 1);
  assert.equal(env.input.snapshot().axes.ry, -1);
  emit(env.left, 'pointermove', { pointerId: 1, clientX: -100, clientY: 50 });
  assert.equal(env.input.snapshot().axes.lx, -1);
  emit(env.left, 'pointercancel', { pointerId: 1 });
  assert.equal(env.input.snapshot().axes.lx, 0);
  assert.equal(env.input.snapshot().axes.ry, -1);
  emit(env.right, 'pointerup', { pointerId: 2 });
  assert.equal(env.input.snapshot().axes.ry, 0);
  env.controller.destroy();
});

test('polling selects a standard gamepad in a nonzero slot without erasing keyboard input', () => {
  const env = setup(); const pad = gamepad(); pad.buttons[1] = { pressed: true, touched: true, value: 1 };
  env.setPads([gamepad(0, { mapping: '', id: 'Unsupported pad' }), null, pad]);
  emit(env.document, 'keydown', { code: 'KeyJ' });
  emit(env.document, 'keydown', { code: 'KeyD' });
  env.tick();
  assert.equal(env.input.snapshot().buttons.A, true);
  assert.equal(env.input.snapshot().buttons.B, true);
  assert.equal(env.input.snapshot().axes.lx, 1);
  assert.equal(env.labels.at(-1), 'Standard controller');
  env.setPads([]); env.tick();
  assert.equal(env.input.snapshot().buttons.B, false);
  assert.equal(env.input.snapshot().buttons.A, true);
  assert.equal(env.labels.at(-1), null);
  env.controller.destroy();
});

test('gamepad deadzone and quantization suppress idle drift messages', () => {
  const env = setup(); const pad = gamepad(); env.setPads([null, null, pad]);
  env.tick(); const baseline = env.changes();
  pad.axes = [0.08, -0.12, 0.001, -0.07]; env.tick();
  assert.equal(env.input.snapshot().axes.lx, 0);
  assert.equal(env.changes(), baseline);
  pad.axes = [0.8, 0, 0, 0]; env.tick(); const moved = env.changes();
  pad.axes[0] = 0.8001; env.tick();
  assert.equal(env.changes(), moved);
  assert.ok(env.input.snapshot().axes.lx > 0.7);
  env.controller.destroy();
});

test('gamepad switching releases the old pad before accepting the new pad', () => {
  const env = setup(); const first = gamepad(); first.buttons[0].pressed = true;
  env.setPads([null, null, first]); env.tick();
  const second = gamepad(3, { id: 'Second controller' }); second.buttons[1].pressed = true;
  env.setPads([null, null, null, second]); env.tick();
  assert.equal(env.input.snapshot().buttons.A, false);
  assert.equal(env.input.snapshot().buttons.B, true);
  assert.equal(env.labels.at(-1), 'Second controller');
  env.controller.destroy();
});

test('gamepad triggers control L and R while right bumper controls Z independently', () => {
  const env = setup(); const pad = gamepad();
  pad.buttons[6] = { pressed: true, touched: true, value: 1 };
  pad.buttons[7] = { pressed: true, touched: true, value: 1 };
  env.setPads([pad]); env.tick();
  assert.equal(env.input.snapshot().buttons.L, true);
  assert.equal(env.input.snapshot().buttons.R, true);
  assert.equal(env.input.snapshot().axes.l, 1);
  assert.equal(env.input.snapshot().axes.r, 1);
  assert.equal(env.input.snapshot().buttons.Z, false);
  pad.buttons[6] = { pressed: false, touched: false, value: 0 };
  pad.buttons[7] = { pressed: false, touched: false, value: 0 };
  pad.buttons[5] = { pressed: true, touched: true, value: 1 };
  env.tick();
  assert.equal(env.input.snapshot().buttons.Z, true);
  assert.equal(env.input.snapshot().buttons.R, false);
  assert.equal(env.input.snapshot().axes.r, 0);
  env.controller.destroy();
});

test('blur releases input and suspends gamepad polling until focus returns', () => {
  const env = setup(); const pad = gamepad(); pad.buttons[0].pressed = true;
  env.setPads([pad]); env.tick();
  emit(env.button, 'pointerdown', { pointerId: 1, button: 0 });
  emit(env.window, 'blur'); env.tick();
  assert.equal(env.input.snapshot().buttons.A, false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.button.captured.size, 0);
  emit(env.window, 'focus'); env.tick();
  assert.equal(env.input.snapshot().buttons.A, true);
  env.controller.destroy();
});

test('disabled and destroyed controllers cannot capture input or keep polling', () => {
  const env = setup(); emit(env.document, 'keydown', { code: 'KeyJ' });
  env.controller.setEnabled(false);
  assert.equal(env.input.snapshot().buttons.A, false);
  assert.equal(env.frames.size, 0);
  emit(env.document, 'keydown', { code: 'KeyJ' });
  emit(env.button, 'pointerdown', { pointerId: 1, button: 0 });
  assert.equal(env.input.snapshot().buttons.A, false);
  env.controller.setEnabled(true); emit(env.document, 'keydown', { code: 'KeyJ' });
  assert.equal(env.input.snapshot().buttons.A, true);
  env.controller.destroy(); env.controller.setEnabled(true);
  emit(env.document, 'keydown', { code: 'KeyJ' });
  assert.equal(env.input.snapshot().buttons.A, false);
  assert.equal(env.frames.size, 0);
});

test('reset always notifies the consumer of neutral input', () => {
  const env = setup(); const before = env.changes();
  env.controller.reset();
  assert.equal(env.changes(), before + 1);
  env.controller.destroy();
});
