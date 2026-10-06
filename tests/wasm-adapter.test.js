import test from 'node:test';
import assert from 'node:assert/strict';
import { DolphinWasmAdapter, GAMECUBE_BUTTON_IDS, GAMECUBE_AXIS_IDS } from '../src/dolphin-wasm-adapter.js';

function fakeModule() {
  const calls = [];
  const dirs = [];
  const exports = new Map([
    ['dweb_init', (...args) => { calls.push(['init', ...args]); return 1; }],
    ['dweb_load_game', (...args) => { calls.push(['load', ...args]); return 1; }],
    ['dweb_run_frame', (...args) => { calls.push(['frame', ...args]); }],
    ['dweb_set_button', (...args) => { calls.push(['button', ...args]); }],
    ['dweb_set_axis', (...args) => { calls.push(['axis', ...args]); }],
    ['dweb_unload_game', (...args) => { calls.push(['unload', ...args]); }],
    ['dweb_shutdown', (...args) => { calls.push(['shutdown', ...args]); }],
  ]);
  return {
    calls,
    dirs,
    FS: { mkdirTree: (p) => dirs.push(p) },
    cwrap(name) {
      const fn = exports.get(name);
      if (!fn) throw new Error(`missing ${name}`);
      return fn;
    },
  };
}

test('adapter initializes browser filesystem and native host', async () => {
  const mod = fakeModule();
  const adapter = new DolphinWasmAdapter(mod);
  await adapter.init();
  assert.deepEqual(mod.dirs, ['/dolphin/system', '/dolphin/save', '/dolphin/assets', '/content']);
  assert.deepEqual(mod.calls[0], ['init']);
  assert.equal(adapter.isReady(), true);
});

test('adapter boots a mounted game path and runs frames', async () => {
  const mod = fakeModule();
  const adapter = new DolphinWasmAdapter(mod);
  await adapter.init();
  await adapter.bootGamePath('/content/Melee.iso');
  adapter.runFrame();
  assert.deepEqual(mod.calls.slice(-2), [['load', '/content/Melee.iso'], ['frame']]);
});

test('adapter maps GameCube buttons and axes into the browser host ABI', async () => {
  const mod = fakeModule();
  const adapter = new DolphinWasmAdapter(mod);
  await adapter.init();
  adapter.setInput({ buttons: { A: true, B: false, START: true, LEFT: true }, axes: { lx: .5, ly: -1, rx: .25, ry: -.25, l: .8, r: .6 } });
  assert.ok(mod.calls.some(c => c[0] === 'button' && c[1] === GAMECUBE_BUTTON_IDS.A && c[2] === 1));
  assert.ok(mod.calls.some(c => c[0] === 'button' && c[1] === GAMECUBE_BUTTON_IDS.START && c[2] === 1));
  assert.ok(mod.calls.some(c => c[0] === 'axis' && c[1] === GAMECUBE_AXIS_IDS.lx && c[2] === 0.5));
  assert.ok(mod.calls.some(c => c[0] === 'axis' && c[1] === GAMECUBE_AXIS_IDS.ly && c[2] === -1));
});
