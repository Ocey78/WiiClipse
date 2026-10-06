import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const host = () => fs.readFileSync('native/BrowserHost.cpp', 'utf8');
const build = () => fs.readFileSync('native/build-dolphin-wasm.sh', 'utf8');
const patch = () => fs.readFileSync('native/patches/0001-dolphin-web-emscripten.patch', 'utf8');

test('native browser host exposes the web ABI and libretro callbacks', () => {
  const text = host();
  for (const symbol of ['dweb_init', 'dweb_load_game', 'dweb_run_frame', 'dweb_set_button', 'dweb_set_axis'])
    assert.match(text, new RegExp(symbol));
  assert.match(text, /RETRO_ENVIRONMENT_GET_VARIABLE/);
  assert.match(text, /dolphin_cpu_core/);
  assert.match(text, /Cached Interpreter|"5"/);
  assert.match(text, /dolphin_main_cpu_thread/);
  assert.match(text, /dolphin_fastmem/);
  assert.match(text, /dolphin_renderer/);
});

test('native build pins the maintained Dolphin libretro source and uses Emscripten', () => {
  const text = build();
  assert.match(text, /f8603f14e7f5a090e6693857d625a55ea9330534/);
  assert.match(text, /libretro\/dolphin/);
  assert.match(text, /emcmake/);
  assert.match(text, /ENABLE_GENERIC=ON/);
  assert.match(text, /LIBRETRO=ON/);
  assert.match(text, /dolphin_libretro/);
});

test('Emscripten patch turns libretro core into a browser executable and links the host', () => {
  const text = patch();
  assert.match(text, /EMSCRIPTEN/);
  assert.match(text, /BrowserHost\.cpp/);
  assert.match(text, /MODULARIZE/);
  assert.match(text, /EXPORT_ES6/);
  assert.match(text, /workerfs\.js/);
});
