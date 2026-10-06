import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('pwa exposes Dolphin WASM loading state and install metadata',()=>{
  const html=fs.readFileSync('public/index.html','utf8');
  assert.match(html,/Loading Dolphin core/i);
  assert.ok(fs.existsSync('public/manifest.webmanifest'));
  assert.ok(fs.existsSync('public/sw.js'));
  assert.ok(fs.existsSync('src/dolphin-worker.js'));
});
