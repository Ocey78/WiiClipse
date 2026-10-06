import test from 'node:test'; import assert from 'node:assert/strict';
import {InputState} from '../src/input-state.js';
test('normalizes axes and tracks buttons',()=>{const s=new InputState(); s.setAxis('lx',2); s.setButton('A',true); assert.equal(s.snapshot().axes.lx,1); assert.equal(s.snapshot().buttons.A,true);});
