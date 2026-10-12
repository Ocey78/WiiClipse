import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGameFile } from '../src/game-file.js';

test('accepts GameCube disc images and homebrew with their existing classification', () => {
  for (const [name, system] of [
    ['game.iso', 'GameCube'],
    ['GAME.GCM', 'GameCube'],
    ['homebrew.dol', 'GameCube homebrew'],
    ['HOMEBREW.ELF', 'GameCube homebrew'],
  ]) {
    const file = classifyGameFile(name, 10);
    assert.equal(file.supported, true);
    assert.equal(file.system, system);
  }
});

test('accepts WAD files as Wii channels regardless of extension case', () => {
  for (const name of ['channel.wad', 'CHANNEL.WAD', 'channel.WaD']) {
    const file = classifyGameFile(name, 4096);
    assert.equal(file.supported, true);
    assert.equal(file.system, 'Wii channel (WAD)');
    assert.equal(file.extension, 'wad');
    assert.equal(file.name, name);
    assert.equal(file.bytes, 4096);
    assert.equal(file.reason, '');
  }
});

test('rejects unsupported files truthfully', () => {
  for (const name of ['game.rvz', 'channel.wad.txt', 'channel']) {
    const file = classifyGameFile(name, 10);
    assert.equal(file.supported, false);
    assert.equal(file.system, 'Unknown');
    assert.ok(file.reason);
  }
});

test('empty or invalid-size files cannot be sent to the native loader', () => {
  for (const bytes of [0, -1, Infinity, NaN]) {
    const file = classifyGameFile('game.iso', bytes);
    assert.equal(file.supported, false);
    assert.match(file.reason, /empty|size/i);
  }
});
