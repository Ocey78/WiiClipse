import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../native/browser-compiler.js', import.meta.url), 'utf8');
let library;
vm.runInNewContext(source, { addToLibrary: value => { library = value; }, WebAssembly, Uint8Array, SharedArrayBuffer, TextEncoder, console });

function environment(overrides = {}) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
  const end = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from([
    0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,
    7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,0,11]))).exports.run;
  table.set(0, end);
  const installs = [], failures = [], released = [], free = [];
  const config = { memory, table, memoryLimits: { minimum: 2, maximum: 8 },
    addFunction(fn) { const slot = free.length ? free.pop() : table.grow(1); table.set(slot, fn); return slot; },
    removeFunction(slot) { table.set(slot, null); released.push(slot); free.push(slot); },
    install(...args) { installs.push(args); return 1; },
    failed(...args) { failures.push(args); },
    evict() { return 1; },
    ...overrides };
  return { memory, table, installs, failures, released, config, compiler: library.$DwebBrowserCompiler(config) };
}
const descriptor = (ops, extra = {}) => ({ version: 1, gate: 100, blockID: 1, epoch: 1,
  entry: 200, end: 400, state: { gpr: 0, pc: 128, npc: 132 },
  ops: ops.at(-1)?.terminal ? ops : [...ops, { kind: 'callback', role: 'end', handler: 0, payload: 0, distance: 12, terminal: true }], ...extra });
const integer = (kind, value = 0, dst = 3, a = 1, b = 2) => ({ kind: 'integer', ops: [{ kind, value: value >>> 0, dst, a, b }] });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function drain(compiler) {
  const until = Date.now() + 5000;
  while (compiler.stats().pending && Date.now() < until) await settle();
  assert.equal(compiler.stats().pending, 0, 'asynchronous compilation jobs finish');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Reference is BrowserInteger::Execute's uint32 semantic contract. Existing
// native source-extracted fixtures separately compare that contract to handlers.
function reference(op, gpr) {
  const a = gpr[op.a], b = gpr[op.b], v = op.value;
  const rol = (x, n) => ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0;
  switch (op.kind) {
    case 0: return v;
    case 1: return (a + v) >>> 0;
    case 2: return Math.imul(a, v) >>> 0;
    case 3: return (a | v) >>> 0;
    case 4: return (a ^ v) >>> 0;
    case 5: return (rol(a, op.b) & v) >>> 0;
    case 6: return ((gpr[op.dst] & ~v) | (rol(a, op.b) & v)) >>> 0;
    case 7: return (rol(a, b & 31) & v) >>> 0;
    case 8: return (a + b) >>> 0;
    case 9: return (b - a) >>> 0;
    case 10: return Math.imul(a, b) >>> 0;
    case 11: return (-a) >>> 0;
    case 12: return (a & b) >>> 0;
    case 13: return (a & ~b) >>> 0;
    case 14: return (a | b) >>> 0;
    case 15: return (a | ~b) >>> 0;
    case 16: return (a ^ b) >>> 0;
    case 17: return (~(a & b)) >>> 0;
    case 18: return (~(a | b)) >>> 0;
    case 19: return (~(a ^ b)) >>> 0;
    case 20: return (b & 32) ? 0 : (a << (b & 31)) >>> 0;
    case 21: return (b & 32) ? 0 : a >>> (b & 31);
    case 22: return Math.clz32(a);
    case 23: return ((a << 24) >> 24) >>> 0;
    case 24: return ((a << 16) >> 16) >>> 0;
    default: throw new Error('unsupported reference operation');
  }
}

test('generated integer Wasm matches two million randomized states with aliased registers', async () => {
  const env = environment();
  let seed = 0x79b31ade, checks = 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const aliases = [[3, 1, 2], [1, 1, 2], [2, 1, 2], [1, 1, 1]];
  const values = [0, 0xffffffff, 0x80000000, 0x5a69965a];
  const words = new Uint32Array(env.memory.buffer);
  for (let kind = 0; kind < 25; ++kind) for (const [dst, a, b] of aliases) for (const value of values) {
    const op = integer(kind, value, dst, a, b).ops[0];
    const run = await env.compiler.compile(descriptor([{ kind: 'integer', ops: [op] }]));
    for (let iteration = 0; iteration < 5000; ++iteration) {
      // Every GPR participates in the randomized machine state; store checks
      // verify that only the destination changes, including aliased sources.
      for (let r = 0; r < 32; ++r) words[r] = random();
      if (iteration < 8) { words[a] = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x80, 0x8000, 0xffff][iteration]; words[b] = [0, 31, 32, 63, 64, 0xffffffff, 0x80000000, 0x80000020][iteration]; }
      const before = words.slice(0, 32), expected = reference(op, before);
      assert.equal(run(0, 0), 0);
      assert.equal(words[dst], expected, `kind=${kind}, dst=${dst}, a=${a}, b=${b}, value=${value}`);
      for (let r = 0; r < 32; ++r) if (r !== dst) assert.equal(words[r], before[r]);
      ++checks;
    }
  }
  assert.equal(checks, 2_000_000);
});

test('mixed runs preserve sequential aliasing and remain bound to grown shared memory', async () => {
  const env = environment();
  const ops = [integer(1, 3, 1, 1, 2), integer(8, 0, 2, 1, 2), integer(6, 0xf0f00f0f, 1, 2, 2), integer(21, 0, 3, 1, 2)];
  const run = await env.compiler.compile(descriptor(ops));
  env.memory.grow(1);
  const words = new Uint32Array(env.memory.buffer);
  for (const state of [0, 4096, 2 * 65536]) {
    const offset = state / 4; for (let r = 0; r < 32; ++r) words[offset + r] = r * 1234567;
    const expected = words.slice(offset, offset + 32);
    for (const batch of ops) for (const op of batch.ops) expected[op.dst] = reference(op, expected);
    assert.equal(run(state, 1234), 0);
    assert.deepEqual(words.slice(offset, offset + 32), expected);
  }
});

test('immediate rotations cover every shift and preserve old aliased destination', async () => {
  const env = environment(); const words = new Uint32Array(env.memory.buffer);
  for (const kind of [5, 6]) for (let shift = 0; shift < 32; ++shift) for (const aliased of [false, true]) {
    const op = integer(kind, 0x89abcdef, aliased ? 1 : 3, 1, shift).ops[0];
    const run = await env.compiler.compile(descriptor([{ kind: 'integer', ops: [op] }]));
    for (const value of [0, 1, 0x80000000, 0xffffffff, 0x7986f35a]) {
      words.fill(0, 0, 32); words[3] = 0xdeadbeef; words[1] = value;
      const expected = reference(op, words);
      assert.equal(run(0, 0), 0); assert.equal(words[op.dst], expected);
    }
  }
});

test('generated modules expose stable profiler names without guest identifiers', () => {
  const env = environment(); const prepared = env.compiler.encode(descriptor([integer(0, 42)]));
  const module = new WebAssembly.Module(prepared.bytes);
  const names = WebAssembly.Module.customSections(module, 'name');
  assert.equal(names.length, 1);
  const text = new TextDecoder().decode(names[0]);
  assert.match(text, /WiiClipseBrowserBlock/); assert.match(text, /browser_block/);
  assert.doesNotMatch(text, /gate|blockID|epoch|entry|payload/);
});

test('optional EndBlock fast path observes live MMCR state and preserves legacy fallback', async () => {
  const env = environment();
  const u = n => { const bytes = []; do { const b = n & 127; n >>>= 7; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
  const sec = (id, bytes) => [id, ...u(bytes.length), ...bytes];
  // Native observer models EndBlock state writes and marks original helper use.
  const code = [32,0,32,0,40,2,...u(132),54,2,...u(128),
    32,0,32,0,40,2,...u(136),65,16,107,54,2,...u(136),
    32,0,32,0,40,2,...u(148),65,1,106,54,2,...u(148),65,0,11];
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,
    ...sec(1,[1,96,2,127,127,1,127]),
    ...sec(2,[1,3,101,110,118,6,109,101,109,111,114,121,2,3,2,8]),
    ...sec(3,[1,0]), ...sec(7,[1,3,114,117,110,0,0]),
    ...sec(10,[1,...u(code.length+1),0,...code])]);
  env.table.set(1, (await WebAssembly.instantiate(bytes,{env:{memory:env.memory}})).instance.exports.run);
  const end = {kind:'callback',role:'end',handler:1,payload:0,distance:16,terminal:true,cycles:16};
  const state = {gpr:0,pc:128,npc:132,downcount:136,mmcr0:140,mmcr1:144};
  const fast = await env.compiler.compile(descriptor([end],{state}));
  const legacy = await env.compiler.compile(descriptor([end]));
  const missingCycles = await env.compiler.compile(descriptor([{...end,cycles:undefined}],{state}));
  env.memory.grow(1);
  const words = new Uint32Array(env.memory.buffer);
  for (const pointer of [0,2*65536]) for (const [mmcr0,mmcr1] of [[0,0],[1,0],[0,1],[0x80000000,0],[0,0xffffffff]]) {
    for (const downcount of [0,15,16,0x80000000,0xffffffff]) {
      const base=pointer/4; words[base+32]=7; words[base+33]=0xffffffff; words[base+34]=downcount;
      words[base+35]=mmcr0; words[base+36]=mmcr1; words[base+37]=0;
      assert.equal(fast(pointer,0),0);
      assert.equal(words[base+32],0xffffffff); assert.equal(words[base+34],(downcount-16)>>>0);
      assert.equal(words[base+37],(mmcr0|mmcr1)===0?0:1);
      assert.equal(words[base+35],mmcr0); assert.equal(words[base+36],mmcr1);
    }
  }
  for (const run of [legacy,missingCycles]) {
    words[33]=123; words[34]=3; words[35]=words[36]=words[37]=0;
    assert.equal(run(0,0),0); assert.equal(words[32],123); assert.equal(words[34],0xfffffff3); assert.equal(words[37],1);
  }
});

test('instruction helpers are imported native Wasm functions with exact PC/NPC writes', async () => {
  const env = environment();
  // Actual Emscripten aggregate ABI: raw vii handlers receive an instruction
  // pointer. The scalar viii bridge constructs a by-value scratch copy then
  // invokes that raw handler natively. No JavaScript function imports occur.
  const u = n => { const bytes = []; do { const b = n & 127; n >>>= 7; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
  const name = s => [s.length, ...new TextEncoder().encode(s)];
  const vec = items => [items.length, ...items.flat()];
  const sec = (id, bytes) => [id, ...u(bytes.length), ...bytes];
  const body = ops => [ops.length + 2, 0, ...ops, 11];
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,
    ...sec(1, vec([[96,2,127,127,0], [96,3,127,127,127,0]])),
    ...sec(2, vec([[...name('env'), ...name('memory'), 2,3,2,8], [...name('env'), ...name('table'), 1,112,0,2]])),
    ...sec(3, vec([[0],[1]])),
    ...sec(7, vec([[...name('raw'),0,0], [...name('bridge'),0,1]])),
    ...sec(10, vec([
      body([32,0,32,1,40,2,0,54,2,0]),
      body([65,0x80,8,32,1,54,2,0,32,0,65,0x80,8,32,2,17,0,0]),
    ]))]);
  const helpers = (await WebAssembly.instantiate(bytes, { env: { memory: env.memory, table: env.table } })).instance.exports;
  env.table.set(1, helpers.raw); env.table.grow(1); env.table.set(2, helpers.bridge);
  const run = await env.compiler.compile(descriptor([
    { kind: 'instruction', handler: 1, interpreter: 512, word: 0xffffffff, pc: 0xfffffffc },
    integer(0, 0x87654321, 4),
    { kind: 'instruction', handler: 1, interpreter: 516, word: 0x11223344, pc: null },
  ], { instructionBridge: 2 }));
  const words = new Uint32Array(env.memory.buffer); words[32] = 10; words[33] = 20;
  assert.equal(run(0, 999), 0);
  assert.equal(words[32], 0xfffffffc); assert.equal(words[33], 0);
  assert.equal(words[128], 0xffffffff); assert.equal(words[129], 0x11223344);
  assert.equal(words[4], 0x87654321);
});

test('checked callback zero exits before later instructions, nonzero continues to original EndBlock', async () => {
  const env = environment();
  // Native Wasm iii callback returns its payload argument. No JS function import.
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,
    3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,32,1,11]);
  const cb = (await WebAssembly.instantiate(bytes)).instance.exports.run; env.table.set(1, cb);
  for (const payload of [0, 16, 0xffffffff]) {
    const run = await env.compiler.compile(descriptor([
      integer(0, 11, 1), { kind: 'callback', role: 'checked', handler: 1, payload, distance: 16, terminal: false },
      integer(0, 22, 2), { kind: 'callback', role: 'end', handler: 1, payload: 0, distance: 12, terminal: true },
      // A terminal record must end the descriptor; reject instead of silently
      // discarding later side effects. This test only submits valid descriptors.
    ]));
    const words = new Uint32Array(env.memory.buffer); words[1] = words[2] = 0;
    assert.equal(run(0, 0), 0); assert.equal(words[1], 11); assert.equal(words[2], payload === 0 ? 0 : 22);
  }
});

test('original FPU guard role exits on zero and continues only when FPU is available', async () => {
  const env = environment();
  // Native iii observer: load its payload availability value, return0/stride.
  // The actual CheckFPU side effects are source-extracted in the native fixture.
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,
    2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,3,2,8,
    3,2,1,0,7,7,1,3,114,117,110,0,0,10,9,1,7,0,32,1,40,2,0,11]);
  const observer = (await WebAssembly.instantiate(bytes, { env: { memory: env.memory } })).instance.exports.run;
  env.table.set(1, observer);
  const run = await env.compiler.compile(descriptor([integer(0, 11, 1),
    { kind: 'callback', role: 'fpu', handler: 1, payload: 256, distance: 16, terminal: false }, integer(0, 22, 2)]));
  const words = new Uint32Array(env.memory.buffer);
  for (const available of [0, 16]) {
    words[64] = available; words[1] = words[2] = 0;
    assert.equal(run(0, 0), 0); assert.equal(words[1], 11); assert.equal(words[2], available ? 22 : 0);
  }
});

test('retained native interpret runs preserve payload updates and integer/checked boundaries', async () => {
  const env = environment();
  const u = n => { const bytes=[]; do {const b=n&127;n>>>=7;bytes.push(b|(n?128:0));} while(n);return bytes; };
  const sec = (id,bytes) => [id,...u(bytes.length),...bytes];
  // Native iii run reads the retained Header's count and each operand word.
  // It returns zero on a simulated early exit, otherwise the exact run stride.
  const ops=[32,1,40,2,0,69,4,64,65,0,15,11,
    2,64,3,64,32,2,32,1,40,2,4,79,13,1,
    32,0,32,0,40,2,4,32,1,32,2,65,8,108,106,40,2,16,106,54,2,4,
    32,2,65,1,106,33,2,12,0,11,11,
    32,1,40,2,4,65,8,108,65,16,106,11];
  const code=[1,1,127,...ops];
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,
    ...sec(1,[1,96,2,127,127,1,127]),
    ...sec(2,[1,3,101,110,118,6,109,101,109,111,114,121,2,3,2,8]),
    ...sec(3,[1,0]), ...sec(7,[1,3,114,117,110,0,0]), ...sec(10,[1,...u(code.length),...code])]);
  env.table.set(1,(await WebAssembly.instantiate(bytes,{env:{memory:env.memory}})).instance.exports.run);
  const runRecord=(payload,count)=>({kind:'callback',role:'interpret-run',handler:1,payload,count,distance:16+count*8,terminal:false});
  const words=new Uint32Array(env.memory.buffer);
  const writeRun=(payload,count)=>{words[payload/4]=1;words[payload/4+1]=count;for(let i=0;i<count;++i)words[payload/4+4+i*2]=i+1;};
  for(const count of [1,2,8,32]) {
    writeRun(512,count); writeRun(1024,2);
    const run=await env.compiler.compile(descriptor([runRecord(512,count),integer(1,5,1,1),runRecord(1024,2),integer(0,99,2)]));
    words[1]=3;words[2]=0;words[32]=123;words[33]=456;
    assert.equal(run(0,0),0);assert.equal(words[1],3+count*(count+1)/2+5+3);assert.equal(words[2],99);
    assert.equal(words[32],123);assert.equal(words[33],456);
    words[128]=0;words[1]=3;words[2]=0;
    assert.equal(run(0,0),0);assert.equal(words[1],3);assert.equal(words[2],0);
    // A fresh helper import carries the whole native run, with no scalar bridge.
    const prepared=env.compiler.encode(descriptor([runRecord(512,count)]));
    assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(prepared.bytes)).filter(x=>x.kind==='function').length,2);
  }
  const checkedBytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,
    3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,32,1,11]);
  env.table.grow(1);env.table.set(2,(await WebAssembly.instantiate(checkedBytes)).instance.exports.run);
  writeRun(512,2);
  for(const payload of [0,16]) {
    const run=await env.compiler.compile(descriptor([runRecord(512,2),
      {kind:'callback',role:'checked',handler:2,payload,distance:16,terminal:false},integer(0,99,2)]));
    words[1]=3;words[2]=0;assert.equal(run(0,0),0);assert.equal(words[1],6);assert.equal(words[2],payload?99:0);
  }
  for(const bad of [{count:0},{count:33},{count:1.5},{count:undefined},{terminal:true},{distance:20}]) {
    const d=descriptor([{...runRecord(512,2),...bad}]);
    assert.equal(env.compiler.request(JSON.stringify(d),d.gate,d.blockID,d.epoch),-1);
  }
  const oversized=descriptor(Array.from({length:129},()=>runRecord(512,32)));
  assert.equal(env.compiler.request(JSON.stringify(oversized),oversized.gate,oversized.blockID,oversized.epoch),-1);
});

test('invalid descriptors and unsupported helpers leave original path untouched', () => {
  const env = environment();
  for (const d of [descriptor([{ kind: 'hle' }]), descriptor([integer(25)]),
    descriptor([integer(0, 1, 32)]), descriptor([integer(0)], { version: 2 }),
    descriptor([{ kind: 'instruction', handler: 1, interpreter: 12, word: 0, pc: null }]),
    descriptor([integer(0)], { state: { gpr: 1, pc: 128, npc: 132 } }),
    descriptor([{ kind: 'callback', role: 'end', handler: 1, payload: 0, distance: 8, terminal: true }, integer(0)]),
    descriptor([], { ops: [integer(0)] }),
    descriptor([{ kind: 'callback', role: 'unknown', handler: 0, payload: 0, distance: 12, terminal: true }])]) {
    assert.equal(env.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), -1);
  }
  assert.equal(env.installs.length, 0); assert.equal(env.compiler.stats().pending, 0);
});

test('async install is guarded and a compile failure quietly leaves original execution', async () => {
  const denied = environment({ compile: async () => { throw new WebAssembly.CompileError('CSP denied'); } });
  const d = descriptor([integer(0, 7)]);
  assert.equal(denied.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 1);
  await drain(denied.compiler);
  assert.equal(denied.installs.length, 0); assert.equal(denied.failures.length, 1);
  assert.equal(denied.compiler.stats().failed, 1);
  const rejected = environment({ install: () => 0 });
  assert.equal(rejected.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 1);
  await drain(rejected.compiler);
  assert.equal(rejected.compiler.stats().installed, 0); assert.equal(rejected.released.length, 1);
});

test('clear makes delayed jobs stale, release reuses slots, and old clear cannot remove newer epoch', async () => {
  const gate = deferred();
  const env = environment({ compile: async bytes => { await gate.promise; return WebAssembly.compile(bytes); } });
  const d = descriptor([integer(0, 7)]);
  assert.equal(env.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 1);
  env.compiler.clear(2); gate.resolve(); await drain(env.compiler);
  assert.equal(env.installs.length, 0);
  const fresh = { ...d, epoch: 2, blockID: 2 };
  assert.equal(env.compiler.request(JSON.stringify(fresh), fresh.gate, fresh.blockID, fresh.epoch), 1);
  await drain(env.compiler);
  assert.equal(env.installs.length, 1);
  const slot = env.installs[0][3]; env.compiler.clear(1);
  assert.notEqual(env.table.get(slot), null);
  env.compiler.release(slot); assert.equal(env.table.get(slot), null);
  const next = { ...fresh, blockID: 3 };
  assert.equal(env.compiler.request(JSON.stringify(next), next.gate, next.blockID, next.epoch), 1);
  await drain(env.compiler); assert.equal(env.installs.at(-1)[3], slot);
});

test('16 pending jobs remain bounded across cancellation and 512 installed slots evict safely', async () => {
  const gate = deferred(); const env = environment({ compile: async bytes => { await gate.promise; return WebAssembly.compile(bytes); } });
  for (let i = 0; i < 16; ++i) { const d = descriptor([integer(0, i)], { blockID: i + 1 });
    assert.equal(env.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 1); }
  const d = descriptor([integer(0)], { blockID: 99 });
  assert.equal(env.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 0);
  env.compiler.clear(2);
  const fresh = { ...d, epoch: 2 };
  assert.equal(env.compiler.request(JSON.stringify(fresh), fresh.gate, fresh.blockID, fresh.epoch), 0);
  gate.resolve(); await drain(env.compiler);
  assert.equal(env.compiler.stats().pending, 0);
  const full = environment();
  for (let batch = 0; batch < 32; ++batch) {
    for (let i = 0; i < 16; ++i) { const job = descriptor([integer(0)], { blockID: batch * 16 + i + 1 });
      assert.equal(full.compiler.request(JSON.stringify(job), job.gate, job.blockID, job.epoch), 1); }
    await drain(full.compiler);
  }
  assert.equal(full.compiler.stats().installed, 512);
  const oldSlot = full.installs[0][3];
  full.config.evict = (gate, id, epoch, slot) => {
    assert.equal(slot, oldSlot); assert.notEqual(full.table.get(slot), null, 'native gate invalidates before slot removal'); return 1;
  };
  assert.equal(full.compiler.request(JSON.stringify(d), d.gate, d.blockID, d.epoch), 1);
  await drain(full.compiler);
  assert.equal(full.compiler.stats().installed, 512); assert.equal(full.compiler.stats().evicted, 1);
  assert.equal(full.installs.at(-1)[3], oldSlot);
  const before = full.compiler.stats(), releases = full.released.length;
  full.config.evict = () => 0; // native reports an active gate: no reclamation
  const refused = { ...d, blockID: 600 };
  assert.equal(full.compiler.request(JSON.stringify(refused), refused.gate, refused.blockID, refused.epoch), 1);
  await drain(full.compiler);
  assert.equal(full.compiler.stats().installed, 512);
  assert.equal(full.compiler.stats().evicted, before.evicted);
  assert.equal(full.released.length, releases);
  assert.equal(full.failures.length, 1);
  full.compiler.clear(2); assert.equal(full.compiler.stats().installed, 0);
});

test('Emscripten bridge initializes lazily after postsets and refuses pthread ownership', async () => {
  const env = environment(); let captured;
  const context = vm.createContext({ WebAssembly, Uint8Array, SharedArrayBuffer, TextEncoder,
    addToLibrary: value => { captured = value; }, Module: {
      _dweb_browser_compiler_install: env.config.install, _dweb_browser_compiler_failed: env.config.failed,
      _dweb_browser_compiler_evict: env.config.evict },
    UTF8ToString: () => JSON.stringify(descriptor([integer(0, 42)])),
    addFunction: env.config.addFunction, removeFunction: env.config.removeFunction,
    wasmMemory: undefined, wasmTable: undefined, ENVIRONMENT_IS_PTHREAD: false });
  vm.runInContext(source, context); context.DwebBrowserCompiler = captured.$DwebBrowserCompiler;
  if (captured.$DwebBrowserCompiler__postset) vm.runInContext(captured.$DwebBrowserCompiler__postset, context);
  assert.equal(captured.dweb_browser_compile_request(123, 100, 1, 1), 0, 'early call waits for runtime globals');
  context.wasmMemory = env.memory; context.wasmTable = env.table;
  assert.equal(captured.dweb_browser_compile_request(123, 100, 1, 1), 1);
  await drain(context.DwebBrowserCompiler.instance);
  assert.equal(env.installs.length, 1);
  context.ENVIRONMENT_IS_PTHREAD = true;
  assert.equal(captured.dweb_browser_compile_request(123, 100, 1, 1), -1);
});
