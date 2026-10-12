import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = process.env.DOLPHIN_SOURCE || 'native/.build/dolphin';
const directory = await mkdtemp(path.join(tmpdir(), 'wiiclipse-cpu-profile-'));
try {
  const header = await readFile(path.join(sourceRoot,
    'Source/Core/Core/PowerPC/CachedInterpreter/BrowserCPUProfile.h'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  assert.ok(header, 'Native diagnostic counter and snapshot implementation must exist');
  await writeFile(path.join(directory, 'BrowserCPUProfile.h'), header);
  const harness = path.join(directory, 'cpu-profile.cpp');
  await writeFile(harness, `
#include <cassert>
#include <cstdint>
#include <iostream>
#include <optional>
#include "BrowserCPUProfile.h"
int main() {
  BrowserCPU::Profile profile;
  unsigned reads=0;
  auto reader=[&](uint32_t pc)->std::optional<uint32_t> { ++reads; return pc^0x60000000u; };
  for (unsigned i=0;i<128;i++) profile.Record(0x80001000u,3);
  assert(reads==0);
  std::cout << profile.Snapshot(3,reader) << '\\n';
  profile.SetEnabled(true);
  for (unsigned i=0;i<192;i++) profile.Record(0x80001000u,3);
  for (unsigned i=0;i<128;i++) profile.Record(0x80001000u,1);
  for (unsigned i=0;i<64;i++) profile.Record(0,3);
  assert(reads==0);
  std::cout << profile.Snapshot(3,reader) << '\\n';
  assert(reads==24); // twelve words for matching flags at PC0 and PC0x80001000
  profile.Reset();
  reads=0;
  // More unique samples than slots must remain bounded, and only top32 entries
  // may invoke the snapshot reader. No sampling call may fetch instructions.
  for (uint32_t pc=0;pc<5000;pc++) for (unsigned i=0;i<64;i++) profile.Record(pc*4,3);
  assert(reads==0);
  std::cout << profile.Snapshot(3,reader) << '\\n';
  assert(reads<=384);
  profile.Reset();
  profile.SetEnabled(false);
  for (unsigned i=0;i<256;i++) profile.Record(0x80001000u,3);
  std::cout << profile.Snapshot(3,reader) << '\\n';
}
`);
  const executable = path.join(directory, process.platform === 'win32' ? 'cpu-profile.exe' : 'cpu-profile');
  let compilation;
  if (process.platform === 'win32') {
    const setup = process.env.VCVARS64 || 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
    const batch = path.join(directory, 'compile.cmd');
    await writeFile(batch, `@echo off\r\ncall "${setup}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc "${harness}" /Fe:"${executable}" /Fo:"${path.join(directory, 'cpu-profile.obj')}"\r\nexit /b %errorlevel%\r\n`);
    compilation = spawnSync('cmd.exe', ['/d', '/c', batch], { encoding: 'utf8', windowsHide: true });
  } else compilation = spawnSync(process.env.CXX || 'c++', ['-std=c++17', harness, '-o', executable], { encoding: 'utf8' });
  assert.equal(compilation.status, 0, `Profile fixture compilation failed:\n${compilation.stdout}\n${compilation.stderr}`);
  const execution = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true });
  assert.equal(execution.status, 0, `Profile fixture failed:\n${execution.stdout}\n${execution.stderr}`);
  const [disabled, sampled, bounded, reset] = execution.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.seenBlocks, 0);
  assert.deepEqual(disabled.blocks, []);
  assert.equal(sampled.seenBlocks, 384);
  assert.equal(sampled.sampledBlocks, 6);
  assert.equal(sampled.stride, 64);
  assert.deepEqual(sampled.blocks.map(({pc,featureFlags,count}) => [pc,featureFlags,count]),
    [[0x80001000,3,3],[0x80001000,1,2],[0,3,1]]);
  assert.equal(sampled.blocks[0].words.length, 12);
  assert.equal(sampled.blocks[0].words[0], 0xe0001000);
  assert.deepEqual(sampled.blocks[1].words, [], 'mismatched translation flags cannot produce misleading words');
  assert.equal(bounded.capacity, 4096);
  assert.equal(bounded.sampledBlocks, 5000);
  assert.ok(bounded.droppedSamples > 0);
  assert.equal(bounded.blocks.length, 32);
  assert.equal(reset.seenBlocks, 0);
  assert.deepEqual(reset.blocks, []);
  const cached = await readFile(path.join(sourceRoot,
    'Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp'), 'utf8');
  const gate = '#if defined(__EMSCRIPTEN__) && defined(DWEB_CPU_DIAGNOSTICS)';
  const exportsStart = cached.indexOf(gate);
  assert.ok(exportsStart >= 0, 'Real compile-gated native exports must exist');
  const exportsEnd = cached.indexOf('\n#endif', exportsStart) + '\n#endif'.length;
  const exports = cached.slice(exportsStart, exportsEnd).replace(/^#include.*\r?\n/gm, '');
  const entryStart = cached.indexOf('void CachedInterpreter::ExecuteOneBlock()');
  const dispatch = 'const u8* normal_entry = m_block_cache.Dispatch();';
  const entryEnd = cached.indexOf(dispatch, entryStart) + dispatch.length;
  assert.ok(entryStart >= 0 && entryEnd > entryStart, 'Actual interpreter entry and dispatch required');
  const entry = cached.slice(entryStart, entryEnd) + '\n(void)normal_entry;\n}\n';
  const integration = path.join(directory, 'cpu-profile-entry.cpp');
  await writeFile(integration, `
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <optional>
#include "BrowserCPUProfile.h"
using u8=uint8_t; using u32=uint32_t;
#define EMSCRIPTEN_KEEPALIVE
struct State { u32 pc=0x80001000u,feature_flags=3; };
unsigned instructionReads=0,dispatches=0;
namespace Core {
struct System {
  State state;
  static System& GetInstance() { static System system; return system; }
  State& GetPPCState() { return state; }
};
struct CPUThreadGuard { explicit CPUThreadGuard(System&) {} };
}
namespace PowerPC {
struct ReadResult { u32 value; };
struct MMU {
  static std::optional<ReadResult> HostTryReadInstruction(const Core::CPUThreadGuard&,u32 pc) {
    instructionReads++; return ReadResult{pc^0x60000000u};
  }
};
}
${exports}
struct CachedInterpreter {
  State& m_ppc_state=Core::System::GetInstance().state;
  struct BlockCache { const u8* Dispatch() { dispatches++; return nullptr; } } m_block_cache;
  void ExecuteOneBlock();
};
${entry}
int main() {
  CachedInterpreter cached;
  for (unsigned i=0;i<64;i++) cached.ExecuteOneBlock();
  assert(instructionReads==0 && dispatches==64);
#if defined(__EMSCRIPTEN__) && defined(DWEB_CPU_DIAGNOSTICS)
  dweb_set_cpu_profile(1); dweb_reset_cpu_profile();
  for (unsigned i=0;i<128;i++) cached.ExecuteOneBlock();
  assert(instructionReads==0 && dispatches==192);
  const char* pointer=dweb_cpu_profile();
  const std::string snapshot(pointer);
  dweb_set_cpu_profile(0);
  assert(std::strcmp(pointer,snapshot.c_str())==0);
  assert(instructionReads==12);
  std::cout << snapshot << '\\n';
  dweb_reset_cpu_profile();
  std::cout << dweb_cpu_profile() << '\\n';
#else
  std::cout << "Normal dispatch without diagnostics passed\\n";
#endif
  assert(cached.m_ppc_state.pc==0x80001000u && cached.m_ppc_state.feature_flags==3);
}
`);
  for (const mode of ['native', 'browser', 'diagnostic']) {
    let build;
    if (process.platform === 'win32') {
      const setup = process.env.VCVARS64 || 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
      const batch = path.join(directory, 'compile-entry.cmd');
      const flags = mode === 'native' ? '' : '/D__EMSCRIPTEN__' + (mode === 'diagnostic' ? ' /DDWEB_CPU_DIAGNOSTICS' : '');
      await writeFile(batch, `@echo off\r\ncall "${setup}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc ${flags} "${integration}" /Fe:"${executable}" /Fo:"${path.join(directory,'entry.obj')}"\r\nexit /b %errorlevel%\r\n`);
      build = spawnSync('cmd.exe', ['/d','/c',batch], { encoding:'utf8',windowsHide:true });
    } else build = spawnSync(process.env.CXX || 'c++', ['-std=c++17',
      ...(mode === 'native' ? [] : ['-D__EMSCRIPTEN__']),
      ...(mode === 'diagnostic' ? ['-DDWEB_CPU_DIAGNOSTICS'] : []), integration,'-o',executable], { encoding:'utf8' });
    assert.equal(build.status,0,`${mode} real entry/export compilation failed:\n${build.stdout}\n${build.stderr}`);
    const run = spawnSync(executable,[],{encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,`${mode} entry/export behavior failed:\n${run.stdout}\n${run.stderr}`);
    if (mode === 'diagnostic') {
      const [snapshot, cleared] = run.stdout.trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(snapshot.seenBlocks,128);
      assert.equal(snapshot.blocks[0].count,2);
      assert.equal(snapshot.blocks[0].words.length,12);
      assert.equal(cleared.enabled,false);
      assert.deepEqual(cleared.blocks,[]);
    } else assert.match(run.stdout,/Normal dispatch without diagnostics passed/);
  }
  console.log('CPU diagnostics: disabled sampling, exact stride, flag keys, bounded top32 snapshots and reset passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
