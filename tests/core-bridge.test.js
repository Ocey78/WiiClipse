import test from 'node:test'; import assert from 'node:assert/strict';
import {DolphinCoreBridge} from '../src/core-bridge.js';
test('does not claim to boot without a wasm core',async()=>{const b=new DolphinCoreBridge(); assert.equal(b.isReady(),false); await assert.rejects(()=>b.bootGame(new ArrayBuffer(1)),/core is not loaded/i);});
