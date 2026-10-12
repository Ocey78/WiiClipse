import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Compile the real stream factory and both zero-offset upload implementations.
// GL calls record owned byte snapshots so overwriting previously submitted GPU
// storage (the measured browser stall) fails this test.
const sourceRoot = process.env.DOLPHIN_SOURCE || 'native/.build/dolphin';
const source = await readFile(path.join(sourceRoot,
  'Source/Core/VideoBackends/OGL/OGLStreamBuffer.cpp'), 'utf8');
function definition(prefix) {
  const start = source.indexOf(prefix);
  assert.ok(start >= 0, `Real native definition required: ${prefix}`);
  const opening = source.indexOf('{', start);
  let depth = 1, end = opening + 1;
  while (depth && end < source.length) { depth += Number(source[end] === '{') - Number(source[end] === '}'); end++; }
  assert.equal(depth, 0, 'Native definition must be complete');
  return source.slice(start, end) + (prefix.startsWith('class ') ? ';' : '');
}
const classes = ['class BufferSubData :', 'class BufferData :'].map(definition).join('\n');
const factory = definition('std::unique_ptr<StreamBuffer> StreamBuffer::Create');
const directory = await mkdtemp(path.join(tmpdir(), 'wiiclipse-streaming-'));
try {
  const harness = path.join(directory, 'streaming.cpp');
  await writeFile(harness, `
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>
using u8 = uint8_t;
using u32 = uint32_t;
constexpr u32 GL_ARRAY_BUFFER=1, GL_ELEMENT_ARRAY_BUFFER=2, GL_UNIFORM_BUFFER=3;
constexpr u32 GL_STREAM_DRAW=4, GL_STATIC_DRAW=5;
struct Upload { u32 target, size, usage; std::vector<u8> bytes; };
std::vector<Upload> allocations;
std::vector<Upload> updates;
u32 boundTarget=0, boundBuffer=0;
void glBindBuffer(u32 target, u32 buffer) { boundTarget=target; boundBuffer=buffer; }
void glBufferData(u32 target, u32 size, const void* data, u32 usage) {
  assert(target==boundTarget && boundBuffer!=0);
  const auto* bytes=static_cast<const u8*>(data);
  allocations.push_back({target,size,usage,data ? std::vector<u8>(bytes,bytes+size) : std::vector<u8>(size)});
}
void glBufferSubData(u32 target, u32 offset, u32 size, const void* data) {
  assert(target==boundTarget && boundBuffer!=0 && offset==0);
  const auto* bytes=static_cast<const u8*>(data);
  updates.push_back({target,size,0,std::vector<u8>(bytes,bytes+size)});
}
struct Config {
  bool bSupportsGLBaseVertex=false, bSupportsGLSync=false;
  bool bSupportsGLPinnedMemory=false, bSupportsGLBufferStorage=false;
} g_ogl_config;
namespace DriverDetails {
enum Bug { BUG_BROKEN_BUFFER_STREAM, BUG_BROKEN_PINNED_MEMORY, BUG_BROKEN_BUFFER_STORAGE,
           BUG_INTEL_BROKEN_BUFFER_STORAGE, BUG_BROKEN_UNSYNC_MAPPING };
bool broken_stream=false;
bool HasBug(Bug bug) { return bug==BUG_BROKEN_BUFFER_STREAM && broken_stream; }
}
namespace OGL {
class StreamBuffer {
public:
  static std::unique_ptr<StreamBuffer> Create(u32,u32);
  virtual ~StreamBuffer()=default;
  virtual std::pair<u8*,u32> Map(u32)=0;
  virtual void Unmap(u32)=0;
  const u32 m_buffer=73;
protected:
  StreamBuffer(u32 type,u32 size):m_buffertype(type),m_size(size){}
  const u32 m_buffertype,m_size;
};
// These unsupported mapping paths are never exercised by the no-base-vertex
// native control or browser cases. Reaching any of them is a regression.
class Unsupported : public StreamBuffer {
public:
  Unsupported(u32 type,u32 size,bool=true):StreamBuffer(type,size){ std::abort(); }
  std::pair<u8*,u32> Map(u32) override { std::abort(); }
  void Unmap(u32) override { std::abort(); }
};
using PinnedMemory=Unsupported;
using BufferStorage=Unsupported;
using MapAndSync=Unsupported;
using MapAndOrphan=Unsupported;
${classes}
${factory}
}
int main() {
  for (u32 target : {GL_ARRAY_BUFFER,GL_ELEMENT_ARRAY_BUFFER,GL_UNIFORM_BUFFER}) {
    for (bool broken : {false,true}) {
      DriverDetails::broken_stream=broken;
      allocations.clear(); updates.clear();
      auto stream=OGL::StreamBuffer::Create(target,256);
#ifdef __EMSCRIPTEN__
      const bool orphan=true;
#else
      const bool orphan=broken;
#endif
      const size_t initialAllocations=allocations.size();
#ifdef __EMSCRIPTEN__
      // A large initial store can survive subsequent smaller orphan uploads in
      // ANGLE, retaining megabytes of capacity per tiny draw. Browser streams
      // must create no GPU storage until their first actual used-size upload.
      assert(initialAllocations==0);
#endif
      std::vector<std::vector<u8>> expected;
      for (u32 size : {16u,31u,64u,256u}) {
        const auto mapping=stream->Map(size);
        assert(mapping.second==0 && mapping.first);
        const u8 pattern=static_cast<u8>(size);
        std::fill(mapping.first,mapping.first+size,pattern);
        expected.emplace_back(size,pattern);
        stream->Unmap(size);
      }
      if (orphan) {
        assert(updates.empty());
        assert(allocations.size()==initialAllocations+4);
        for (size_t i=0;i<expected.size();i++) {
          const auto& upload=allocations[initialAllocations+i];
          assert(upload.target==target && upload.size==expected[i].size());
          assert(upload.usage==GL_STREAM_DRAW && upload.bytes==expected[i]);
        }
      } else {
        assert(initialAllocations==1 && allocations[0].usage==GL_STATIC_DRAW);
        assert(allocations.size()==1 && updates.size()==4);
        for (size_t i=0;i<expected.size();i++) assert(updates[i].bytes==expected[i]);
      }
    }
  }
  std::cout << "Stream uploads: real browser/native selection, orphaned bytes and zero offsets passed\\n";
}
`);
  for (const browser of [true, false]) {
    const executable = path.join(directory, process.platform === 'win32' ? 'streaming.exe' : 'streaming');
    let compilation;
    if (process.platform === 'win32') {
      const setup = process.env.VCVARS64 || 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
      const batch = path.join(directory, 'compile.cmd');
      await writeFile(batch, `@echo off\r\ncall "${setup}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc ${browser ? '/D__EMSCRIPTEN__' : ''} "${harness}" /Fe:"${executable}" /Fo:"${path.join(directory, 'streaming.obj')}"\r\nexit /b %errorlevel%\r\n`);
      compilation = spawnSync('cmd.exe', ['/d', '/c', batch], { encoding: 'utf8', windowsHide: true });
    } else compilation = spawnSync(process.env.CXX || 'c++', ['-std=c++17',
      ...(browser ? ['-D__EMSCRIPTEN__'] : []), harness, '-o', executable], { encoding: 'utf8' });
    assert.equal(compilation.status, 0, `${browser ? 'Browser' : 'Native'} compilation failed:\n${compilation.stdout}\n${compilation.stderr}`);
    const execution = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(execution.status, 0, `${browser ? 'Browser' : 'Native'} upload contract failed:\n${execution.stdout}\n${execution.stderr}`);
    console.log(`${browser ? 'Browser' : 'Native'}: ${execution.stdout.trim()}`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
