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
