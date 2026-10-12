import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real patched upload function without building the complete core.
// Run after applying native patches, or set DOLPHIN_SOURCE to a prepared source tree.
const sourceRoot = process.env.DOLPHIN_SOURCE || 'native/.build/dolphin';
const source = await readFile(path.join(sourceRoot,
  'Source/Core/VideoBackends/OGL/ProgramShaderCache.cpp'), 'utf8');
const upload = source.match(/void ProgramShaderCache::UploadConstants\(const void\* data, u32 data_size\)\s*\{[\s\S]*?\n\}/)?.[0];
assert.ok(upload, 'The native utility uniform upload must be available');

const directory = await mkdtemp(path.join(tmpdir(), 'wiiclipse-uniforms-'));
try {
  const harness = path.join(directory, 'uniforms.cpp');
  await writeFile(harness, `
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <utility>
#include <vector>
using u32 = uint32_t;
constexpr int GL_UNIFORM_BUFFER = 1;
#define ADDSTAT(...) ((void)0)
namespace Common {
template <typename T, typename U> T AlignUp(T value, U alignment) {
  return (value + alignment - 1) / alignment * alignment;
}
}
struct StreamBuffer {
  std::array<unsigned char, 4096> bytes;
  u32 mapped = 0, unmapped = 0;
  u32 m_buffer = 73;
  std::pair<unsigned char*, u32> Map(u32 size, u32 alignment) {
    assert(size < bytes.size());
    bytes.fill(0xcd);
    mapped = size;
    return {bytes.data(), alignment * 3};
  }
  void Unmap(u32 size) { unmapped = size; }
} stream;
StreamBuffer* s_buffer = &stream;
struct Binding { u32 index, offset, size; };
std::vector<Binding> bindings;
void glBindBufferRange(int target, u32 index, u32 buffer, u32 offset, u32 size) {
  assert(target == GL_UNIFORM_BUFFER && buffer == stream.m_buffer);
  bindings.push_back({index, offset, size});
}
struct ProgramShaderCache {
  static u32 s_ubo_align;
  static void UploadConstants(const void*, u32);
};
u32 ProgramShaderCache::s_ubo_align = 1;
${upload}
int main() {
  // BuiltinUniforms in PostProcessing.cpp is 140 bytes, but its std140 block
  // occupies 144 bytes. Smaller utility structs also have trailing padding.
  for (u32 alignment : {1u, 16u, 256u}) {
    ProgramShaderCache::s_ubo_align = alignment;
    for (u32 size : {4u, 8u, 12u, 16u, 28u, 140u, 144u, 156u}) {
      std::vector<unsigned char> input(size, 0xa5);
      bindings.clear();
      ProgramShaderCache::UploadConstants(input.data(), size);
#ifdef __EMSCRIPTEN__
      const u32 expected = Common::AlignUp(size, 16u);
#else
      const u32 expected = size;
#endif
      assert(stream.mapped >= expected);
      assert(stream.unmapped == stream.mapped);
      assert(bindings.size() == 4);
      for (u32 i = 0; i < bindings.size(); ++i) {
        assert(bindings[i].index == i + 1);
        assert(bindings[i].offset == alignment * 3);
        assert(bindings[i].size == expected);
      }
      assert(std::all_of(stream.bytes.begin(), stream.bytes.begin() + size,
                         [](unsigned char byte) { return byte == 0xa5; }));
#ifdef __EMSCRIPTEN__
      assert(std::all_of(stream.bytes.begin() + size, stream.bytes.begin() + expected,
                         [](unsigned char byte) { return byte == 0; }));
#endif
      assert(stream.bytes[stream.mapped] == 0xcd);
    }
  }
  std::cout << "Uniform uploads: all sizes, alignments, contents and ranges passed\\n";
}
`);
  for (const browser of [true, false]) {
    const executable = path.join(directory, process.platform === 'win32' ? 'uniforms.exe' : 'uniforms');
    let compilation;
    if (process.platform === 'win32') {
      const setup = process.env.VCVARS64 || 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat';
      const batch = path.join(directory, 'compile.cmd');
      await writeFile(batch, `@echo off\r\ncall "${setup}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc ${browser ? '/D__EMSCRIPTEN__' : ''} "${harness}" /Fe:"${executable}" /Fo:"${path.join(directory, 'uniforms.obj')}"\r\nexit /b %errorlevel%\r\n`);
      compilation = spawnSync('cmd.exe', ['/d', '/c', batch],
        { encoding: 'utf8', windowsHide: true });
    } else {
      compilation = spawnSync(process.env.CXX || 'c++', ['-std=c++17',
        ...(browser ? ['-D__EMSCRIPTEN__'] : []), harness, '-o', executable], { encoding: 'utf8' });
    }
    assert.equal(compilation.status, 0, compilation.error?.message || compilation.stdout + compilation.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${browser ? 'Browser' : 'Desktop'} upload regression: ${result.stdout}${result.stderr}`);
    console.log(`${browser ? 'Browser' : 'Desktop'}: ${result.stdout.trim()}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
