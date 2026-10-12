import test from 'node:test'; import assert from 'node:assert/strict';
import {InputState} from '../src/input-state.js';
test('normalizes axes and tracks buttons',()=>{const s=new InputState(); s.setAxis('lx',2); s.setButton('A',true); assert.equal(s.snapshot().axes.lx,1); assert.equal(s.snapshot().buttons.A,true);});

test('revision changes only when normalized controller state changes', () => {
  const state = new InputState();
  assert.equal(state.revision, 0);
  state.setButton('A', false);
  state.setAxis('lx', 0);
  assert.equal(state.revision, 0);
  state.setButton('A', true);
  state.setButton('A', true);
  state.setAxis('lx', 2);
  state.setAxis('lx', 1);
  assert.equal(state.revision, 2);
  state.setButton('A', false);
  state.setAxis('lx', 0);
  assert.equal(state.revision, 4);
});

test('releasing one source keeps a button held by another source', () => {
  const state = new InputState();
  state.setButton('A', true, 'keyboard');
  state.setButton('A', true, 'touch:1');
  state.setButton('A', false, 'touch:1');
  assert.equal(state.snapshot().buttons.A, true);
  assert.equal(state.revision, 1);
  state.clearSource('keyboard');
  assert.equal(state.snapshot().buttons.A, false);
});

test('axes select the strongest source and restore weaker input on release', () => {
  const state = new InputState();
  state.setAxis('lx', -0.4, 'gamepad');
  state.setAxis('lx', 1, 'keyboard');
  state.setAxis('lx', 0.2, 'gamepad');
  assert.equal(state.snapshot().axes.lx, 1);
  state.clearSource('keyboard');
  assert.equal(state.snapshot().axes.lx, 0.2);
  state.clearSource('gamepad');
  assert.equal(state.snapshot().axes.lx, 0);
});

test('reset releases all sources and prevents old sources from resurfacing', () => {
  const state = new InputState();
  state.setButton('A', true);
  state.setButton('A', true, 'keyboard');
  state.setAxis('ry', -1, 'touch');
  state.reset();
  assert.equal(state.snapshot().buttons.A, false);
  assert.equal(state.snapshot().axes.ry, 0);
  state.setButton('A', false, 'keyboard');
  assert.equal(state.snapshot().buttons.A, false);
});
