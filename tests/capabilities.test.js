import test from 'node:test'; import assert from 'node:assert/strict';
import {detectCapabilities} from '../src/capabilities.js';
test('detects browser emulator capabilities',()=>{const env={document:{createElement:()=>({getContext:(n)=>n==='webgl2'?{}:null})},navigator:{gpu:{},getGamepads(){},serviceWorker:{}}}; const c=detectCapabilities(env); assert.deepEqual(c,{webgl2:true,webgpu:true,gamepad:true,serviceWorker:true});});
