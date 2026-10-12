// Optional Emscripten JS library. Installed callbacks and imported helpers are
// Wasm functions; JavaScript runs only when preparing/promoting/releasing blocks.
// Native gates own block lifetime and reject stale epochs before installation.
addToLibrary({
  $DwebBrowserCompiler__deps: ['$UTF8ToString', '$addFunction', '$removeFunction', '$getWasmTableEntry'],
  $DwebBrowserCompiler: function(configuration) {
    var env = configuration || {
      memory: wasmMemory,
      table: wasmTable,
      // The main core imports this bounded shared memory. Kept explicit because
      // WebAssembly.Memory has no API exposing its declared maximum.
      memoryLimits: { minimum: wasmMemory.buffer.byteLength / 65536, maximum: 32768 },
      addFunction: addFunction,
      removeFunction: removeFunction,
      install: function(gate, id, epoch, slot) {
        return Module['_dweb_browser_compiler_install'](gate, id, epoch, slot);
      },
      failed: function(gate, id, epoch) {
        Module['_dweb_browser_compiler_failed'](gate, id, epoch);
      },
      evict: function(gate, id, epoch, slot) {
        return Module['_dweb_browser_compiler_evict'](gate, id, epoch, slot);
      }
    };
    var epoch = 0;
    var jobs = new Map();
    var installed = new Map();
    var identity = {};
    var sequence = 0;
    var counters = { requested: 0, accepted: 0, promoted: 0, failed: 0, stale: 0, rejected: 0, released: 0, evicted: 0 };
    var compileWasm = env.compile || function(bytes) { return WebAssembly.compile(bytes); };
    var instantiateWasm = env.instantiate || function(module, imports) { return WebAssembly.instantiate(module, imports); };

    function uint(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
    function require(condition) { if (!condition) throw new Error('Unsupported browser block descriptor'); }
    function u(value) {
      var result = [];
      do { var byte = value & 127; value >>>= 7; result.push(byte | (value ? 128 : 0)); } while (value);
      return result;
    }
    function s(value) {
      var result = []; value |= 0;
      while (true) {
        var byte = value & 127; value >>= 7;
        var last = (value === 0 && !(byte & 64)) || (value === -1 && (byte & 64));
        result.push(byte | (last ? 0 : 128)); if (last) return result;
      }
    }
    function name(value) { var bytes = Array.from(new TextEncoder().encode(value)); return u(bytes.length).concat(bytes); }
    function section(id, bytes) { return [id].concat(u(bytes.length), bytes); }
    function vector(items) { return u(items.length).concat.apply(u(items.length), items); }

    function prepare(descriptor) {
      require(env.memory instanceof WebAssembly.Memory && env.memory.buffer instanceof SharedArrayBuffer);
      require(env.table instanceof WebAssembly.Table);
      require(uint(env.memoryLimits.minimum) && uint(env.memoryLimits.maximum) &&
        env.memoryLimits.minimum > 0 && env.memoryLimits.minimum <= env.memoryLimits.maximum);
      require(descriptor && descriptor.version === 1 && uint(descriptor.gate) && uint(descriptor.blockID) &&
        uint(descriptor.epoch) && uint(descriptor.entry) && uint(descriptor.end));
      var state = descriptor.state;
      require(state && ['gpr', 'pc', 'npc'].every(function(field) {
        return uint(state[field]) && (state[field] & 3) === 0 && state[field] < env.memory.buffer.byteLength - 128;
      }));
      require(Array.isArray(descriptor.ops) && descriptor.ops.length > 0 && descriptor.ops.length <= 2048);
      var terminal = descriptor.ops[descriptor.ops.length - 1];
      require(terminal && terminal.kind === 'callback' && terminal.role === 'end' && terminal.terminal === true);
      var functionImports = [];
      var importFunctions = {};
      var importIndices = new Map();
      var code = [];
      var opCount = 0;
      function emit() { for (var i = 0; i < arguments.length; ++i) code.push.apply(code, arguments[i]); }
      function constant(value) { return [0x41].concat(s(value)); }
      function load(register) { return [0x20, 0, 0x28, 2].concat(u(state.gpr + register * 4)); }
      function inverse(bytes) { return bytes.concat(constant(-1), [0x73]); }
      function binary(a, b, opcode) { return a.concat(b, [opcode]); }
      function helper(index, type) {
        require(uint(index) && index < env.table.length);
        var key = type + ':' + index;
        if (importIndices.has(key)) return importIndices.get(key);
        var fn = env.table.get(index); require(typeof fn === 'function');
        var position = functionImports.length, field = 'h' + position;
        functionImports.push(name('native').concat(name(field), [0], u(type)));
        importFunctions[field] = fn; importIndices.set(key, position); return position;
      }
      function integer(op) {
        require(op && Number.isInteger(op.kind) && op.kind >= 0 && op.kind <= 24 && uint(op.value) &&
          ['dst', 'a', 'b'].every(function(field) { return Number.isInteger(op[field]) && op[field] >= 0 && op[field] < 32; }));
        var a = load(op.a), b = load(op.b), v = constant(op.value), result;
        switch (op.kind) {
          case 0: result = v; break;
          case 1: result = binary(a, v, 0x6a); break;
          case 2: result = binary(a, v, 0x6c); break;
          case 3: result = binary(a, v, 0x72); break;
          case 4: result = binary(a, v, 0x73); break;
          case 5: result = a.concat(constant(op.b), [0x77], v, [0x71]); break;
          case 6: result = load(op.dst).concat(constant(~op.value), [0x71], a, constant(op.b), [0x77], v, [0x71, 0x72]); break;
          case 7: result = a.concat(b, [0x77], v, [0x71]); break;
          case 8: result = binary(a, b, 0x6a); break;
          case 9: result = binary(b, a, 0x6b); break;
          case 10: result = binary(a, b, 0x6c); break;
          case 11: result = binary(constant(0), a, 0x6b); break;
          case 12: result = binary(a, b, 0x71); break;
          case 13: result = binary(a, inverse(b), 0x71); break;
          case 14: result = binary(a, b, 0x72); break;
          case 15: result = binary(a, inverse(b), 0x72); break;
          case 16: result = binary(a, b, 0x73); break;
          case 17: result = inverse(binary(a, b, 0x71)); break;
          case 18: result = inverse(binary(a, b, 0x72)); break;
          case 19: result = inverse(binary(a, b, 0x73)); break;
          // Gekko's six-bit shift count differs from Wasm's five-bit count.
          // Test bit5 first; Wasm itself supplies the low-five-bit masking.
          case 20: case 21:
            result = b.concat(constant(32), [0x71, 0x04, 0x7f], constant(0), [0x05],
              a, b, [op.kind === 20 ? 0x74 : 0x76, 0x0b]); break;
          case 22: result = a.concat([0x67]); break;
          case 23: result = a.concat([0xc0]); break;
          case 24: result = a.concat([0xc1]); break;
        }
        // Every source (including old destination for rotate-insert) is loaded
        // before this store, preserving aliased registers without a flush ABI.
        emit([0x20, 0], result, [0x36, 2], u(state.gpr + op.dst * 4));
      }
      for (var record = 0; record < descriptor.ops.length; ++record) {
        var op = descriptor.ops[record]; require(op && typeof op.kind === 'string');
        if (op.kind === 'integer') {
          require(Array.isArray(op.ops) && op.ops.length > 0 && op.ops.length <= 32);
          opCount += op.ops.length; op.ops.forEach(integer);
        } else if (op.kind === 'instruction') {
          require(uint(op.interpreter) && uint(op.word) && (op.pc === null || uint(op.pc)));
          require(uint(op.handler) && op.handler < env.table.length && typeof env.table.get(op.handler) === 'function');
          if (op.pc !== null) {
            emit([0x20, 0], constant(op.pc), [0x36, 2], u(state.pc));
            emit([0x20, 0], constant((op.pc + 4) >>> 0), [0x36, 2], u(state.npc));
          }
          // Emscripten passes UGeckoInstruction aggregates by pointer despite
          // the raw handler's vii signature. A native scalar viii bridge owns
          // the by-value temporary, then calls the original typed handler.
          emit(constant(op.interpreter), constant(op.word), constant(op.handler),
            [0x10], u(helper(descriptor.instructionBridge, 2)));
          ++opCount;
        } else if (op.kind === 'callback') {
          // Native descriptors contain only the fixed-stride checked/FPU guards
          // and EndBlock. Arbitrary AnyCallback return distances cannot be
          // linearized; unknown roles and unterminated blocks are rejected.
          require(uint(op.payload) && uint(op.distance) && op.distance > 0 && (op.distance & 3) === 0 &&
            (op.role === 'checked' || op.role === 'fpu' || op.role === 'end') && op.terminal === (op.role === 'end'));
          require(!op.terminal || record === descriptor.ops.length - 1);
          emit([0x20, 0], constant(op.payload), [0x10], u(helper(op.handler, 1)),
            [0x45, 0x04, 0x40], constant(0), [0x0f, 0x0b]);
          ++opCount;
        } else throw new Error('Unsupported browser callback');
        require(opCount <= 4096 && code.length <= 262144);
      }
      emit(constant(0), [0x0b]);
      var memoryImport = name('env').concat(name('memory'), [2, 3], u(env.memoryLimits.minimum), u(env.memoryLimits.maximum));
      var functionBody = [0].concat(code);
      var bytes = [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, vector([[0x60, 2, 0x7f, 0x7f, 0], [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
          [0x60, 3, 0x7f, 0x7f, 0x7f, 0]])),
        section(2, vector([memoryImport].concat(functionImports))),
        section(3, vector([[1]])),
        section(7, vector([name('run').concat([0], u(functionImports.length))])),
        section(10, vector([u(functionBody.length).concat(functionBody)])),
        // Stable labels distinguish generated modules in CPU profiles without
        // exposing guest PCs, instructions or descriptor identifiers.
        section(0, name('name').concat(
          section(0, name('WiiClipseBrowserBlock')),
          section(1, vector([u(functionImports.length).concat(name('browser_block'))])))));
      return { bytes: new Uint8Array(bytes), imports: { env: { memory: env.memory }, native: importFunctions } };
    }
    function compile(prepared) {
      return compileWasm(prepared.bytes).then(function(module) {
        return instantiateWasm(module, prepared.imports);
      }).then(function(instance) { return instance.exports.run; });
    }
    function release(slot) {
      if (!installed.has(slot)) return;
      installed.delete(slot); env.removeFunction(slot); ++counters.released;
    }
    function request(json, gate, id, requestedEpoch) {
      ++counters.requested;
      var descriptor, prepared;
      try {
        require(typeof json === 'string' && json.length <= 1048576);
        descriptor = JSON.parse(json);
        require(descriptor.gate === gate && descriptor.blockID === id && descriptor.epoch === requestedEpoch);
        prepared = prepare(descriptor);
      } catch (error) { ++counters.rejected; return -1; }
      if (epoch === 0) epoch = requestedEpoch;
      if (requestedEpoch !== epoch) { ++counters.stale; return 0; }
      if (jobs.size >= 16) return 0;
      var job = { key: ++sequence, gate: gate, id: id, epoch: requestedEpoch, owner: identity, canceled: false };
      jobs.set(job.key, job); ++counters.accepted;
      // Promise defers all promotion until the current native request returns.
      Promise.resolve().then(function() { return compile(prepared); }).then(function(fn) {
        if (job.canceled || job.epoch !== epoch || job.owner !== identity) { ++counters.stale; return; }
        if (installed.size >= 512) {
          var oldestSlot = installed.keys().next().value;
          var oldest = installed.get(oldestSlot);
          // Native invalidates the exact gate first and refuses while active.
          // Only that acknowledgement permits table slot reclamation/reuse.
          if (!env.evict || !env.evict(oldest.gate, oldest.id, oldest.epoch, oldestSlot)) {
            ++counters.rejected;
            env.failed(job.gate, job.id, job.epoch);
            return;
          }
          release(oldestSlot); ++counters.evicted;
        }
        var slot = env.addFunction(fn, 'iii');
        var promoted = false;
        try {
          require(uint(slot) && slot < env.table.length && env.table.get(slot) === fn);
          if (!job.canceled && job.epoch === epoch && env.install(job.gate, job.id, job.epoch, slot)) {
            installed.set(slot, job); promoted = true; ++counters.promoted;
          } else {
            ++counters.stale;
            env.failed(job.gate, job.id, job.epoch);
          }
        } finally { if (!promoted) env.removeFunction(slot); }
      }).catch(function(error) {
        ++counters.failed;
        if (!job.canceled && job.epoch === epoch) {
          try { env.failed(job.gate, job.id, job.epoch); } catch (ignored) {}
        }
      }).finally(function() { jobs.delete(job.key); });
      return 1;
    }
    function clear(nextEpoch) {
      if (!uint(nextEpoch) || (epoch && nextEpoch < epoch)) return;
      epoch = nextEpoch;
      jobs.forEach(function(job) { job.canceled = true; });
      // Native gates are invalidated and active callback depth is zero before
      // this function is invoked. Canceled compilations still count toward16.
      Array.from(installed.keys()).forEach(release);
    }
    return {
      request: request, release: release, clear: clear,
      compile: function(descriptor) { return compile(prepare(descriptor)); },
      encode: prepare,
      stats: function() { return Object.assign({ pending: jobs.size, installed: installed.size, epoch: epoch }, counters); }
    };
  },
  dweb_browser_compile_request__deps: ['$DwebBrowserCompiler', '$UTF8ToString'],
  dweb_browser_compile_request: function(pointer, gate, id, epoch) {
    if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD) return -1;
    // Library postsets run before asynchronous Wasm exports/table assignment.
    // Capture those globals only after the native CPU worker requests a block.
    if (!DwebBrowserCompiler.instance) {
      if (!wasmMemory || !wasmTable) return 0;
      DwebBrowserCompiler.instance = DwebBrowserCompiler();
      if (DwebBrowserCompiler.lastEpoch !== undefined)
        DwebBrowserCompiler.instance.clear(DwebBrowserCompiler.lastEpoch);
    }
    // JSON must be copied before the native temporary string is destroyed.
    return DwebBrowserCompiler.instance.request(UTF8ToString(pointer), gate >>> 0, id >>> 0, epoch >>> 0);
  },
  dweb_browser_compile_release__deps: ['$DwebBrowserCompiler'],
  dweb_browser_compile_release: function(slot) {
    if (DwebBrowserCompiler.instance) DwebBrowserCompiler.instance.release(slot >>> 0);
  },
  dweb_browser_compile_clear__deps: ['$DwebBrowserCompiler'],
  dweb_browser_compile_clear: function(epoch) {
    DwebBrowserCompiler.lastEpoch = epoch >>> 0;
    if (DwebBrowserCompiler.instance) DwebBrowserCompiler.instance.clear(epoch >>> 0);
  }
});
