import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compilerProbeSource } from './local-game-performance.mjs';

function probe(module) {
  let listener;
  const queue = [], replies = [];
  vm.runInNewContext(compilerProbeSource, {
    self: { addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; } },
    adapter: module ? { module } : null,
    enqueue: callback => queue.push(callback),
    send: (type, result) => replies.push({ type, ...result }),
  });
  return { queue, replies, send: data => listener({ data }) };
}

test('local compiler probe serializes toggles and reports actual native snapshots', () => {
  const toggles = [];
  let enabled = true;
  const fixture = probe({
    _dweb_set_browser_compiler(value) { toggles.push(value); enabled = !!value; },
    _dweb_browser_compiler_stats() {},
    cwrap(name, result, args) {
      assert.equal(name, 'dweb_browser_compiler_stats');
      assert.equal(result, 'string');
      assert.equal(args.length, 0);
      return () => JSON.stringify({ enabled, compiledCalls: 19 });
    },
  });
  fixture.send({ type: 'frame' });
  assert.equal(fixture.queue.length, 0);
  fixture.send({ type: 'benchmark-compiler', mode: 'off' });
  assert.deepEqual(toggles, [], 'do not alter native state before prior frame work completes');
  fixture.queue.shift()();
  assert.deepEqual(toggles, [0]);
  assert.equal(fixture.replies[0].snapshot.enabled, false);
  fixture.send({ type: 'benchmark-compiler', mode: 'read' });
  fixture.queue.shift()();
  assert.deepEqual(toggles, [0], 'reading stats must not reenable or reset the compiler');
  assert.equal(fixture.replies[1].snapshot.compiledCalls, 19);
  fixture.send({ type: 'benchmark-compiler', mode: 'on' });
  fixture.queue.shift()();
  assert.deepEqual(toggles, [0, 1]);
});

test('missing or malformed compiler stats return explicit failure instead of hanging', () => {
  for (const module of [null, {}, {
    _dweb_set_browser_compiler() {}, _dweb_browser_compiler_stats() {},
    cwrap: () => () => '{broken',
  }]) {
    const fixture = probe(module);
    fixture.send({ type: 'benchmark-compiler', mode: 'read' });
    fixture.queue.shift()();
    assert.equal(fixture.replies.length, 1);
    assert.equal(fixture.replies[0].type, 'benchmark-compiler-result');
    assert.equal(typeof fixture.replies[0].error, 'string');
    assert.ok(fixture.replies[0].error.length > 0);
  }
});
