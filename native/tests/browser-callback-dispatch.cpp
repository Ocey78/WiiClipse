// Build with C++20, Source/Core and generated fixture headers on include paths.
// Reuse exact handler/callback fixtures; the loop and end/integer callbacks below
// are also extracted from production source, with only block-cache/profiler boundaries replaced.
#define main existing_dispatch_regression
#include "browser-direct-interpreter-dispatch.cpp"
#undef main
#include <cstdlib>
#include "Core/PowerPC/CachedInterpreter/BrowserIntegerOps.h"

struct JitBlock
{
  struct ProfileData { static void EndProfiling(ProfileData*, u32) { std::abort(); } };
};
namespace PowerPC
{
std::vector<std::array<u32, 3>> monitor_calls;
void UpdatePerformanceMonitor(u32 cycles, u32 loads, u32 fp, PowerPCState&)
{
  monitor_calls.push_back({cycles, loads, fp});
}
}
template <bool profiled> struct EndOperands;
template <> struct EndOperands<false> { u32 downcount, num_load_stores, num_fp_inst, padding = 0; };
template <> struct EndOperands<true> : EndOperands<false> { JitBlock::ProfileData* profile_data; };
struct BlockCache { const u8* entry = nullptr; const u8* Dispatch() { return entry; } };

#define DECLARE_LOOP(name, callbacks) struct name { \
  using AnyCallback = s32 (*)(PowerPC::PowerPCState&, const void*); \
  template <class T> static AnyCallback AnyCallbackCast(s32 (*fn)(PowerPC::PowerPCState&, const T&)) { return std::bit_cast<AnyCallback>(fn); } \
  using InterpretOperands = Operands; using InterpretAndCheckExceptionsOperands = CheckedOperands; \
  template <bool profile> using EndBlockOperands = EndOperands<profile>; \
  PowerPC::PowerPCState& m_ppc_state; BlockCache m_block_cache; unsigned jit_calls = 0; u32 jit_pc = 0; \
  explicit name(PowerPC::PowerPCState& state) : m_ppc_state(state) {} \
  void Jit(u32 pc) { ++jit_calls; jit_pc = pc; } void ExecuteOneBlock(); \
  template <bool write_pc> static s32 Interpret(PowerPC::PowerPCState& state, const Operands& operands) { return callbacks::Interpret<write_pc>(state, operands); } \
  template <bool write_pc> static s32 InterpretAndCheckExceptions(PowerPC::PowerPCState& state, const CheckedOperands& operands) { return callbacks::InterpretAndCheckExceptions<write_pc>(state, operands); } \
  template <bool profiled> static s32 EndBlock(PowerPC::PowerPCState&, const EndOperands<profiled>&); \
  static s32 RunBrowserIntegerOps(PowerPC::PowerPCState&, const BrowserInteger::Header&); };
DECLARE_LOOP(OriginalLoop, OriginalCallbacks)
DECLARE_LOOP(BrowserLoop, BrowserCallbacks)
#undef DECLARE_LOOP
#undef __EMSCRIPTEN__
#define CachedInterpreter OriginalLoop
#include "callback-dispatch-loop.h"
#undef CachedInterpreter
#define __EMSCRIPTEN__ 1
#define CachedInterpreter BrowserLoop
#include "callback-dispatch-loop.h"
#undef CachedInterpreter

struct Mark { u32 value; u32 padding = 0; };
s32 GenericCallback(PowerPC::PowerPCState& state, const Mark& mark)
{
  state.gpr[12] = mark.value;
  return sizeof(OriginalLoop::AnyCallback) + sizeof(mark);
}
struct Program
{
  alignas(16) std::array<u8, 4096> bytes{};
  size_t used = 0;
  template <class T, class Loop>
  void Add(s32 (*callback)(PowerPC::PowerPCState&, const T&), const T& operands)
  {
    const auto fn = Loop::AnyCallbackCast(callback);
    assert(used % alignof(decltype(fn)) == 0);
    assert(sizeof(T) % alignof(decltype(fn)) == 0);
    std::memcpy(bytes.data() + used, &fn, sizeof(fn)); used += sizeof(fn);
    std::memcpy(bytes.data() + used, &operands, sizeof(operands)); used += sizeof(operands);
  }
  template <class Loop> void IntegerRun()
  {
    const auto fn = Loop::AnyCallbackCast(Loop::RunBrowserIntegerOps);
    BrowserInteger::Batch batch;
    batch.header.count = 2;
    assert(BrowserInteger::Decode((14u << 26) | (5u << 21) | 1u, batch.ops[0]));
    assert(BrowserInteger::Decode((14u << 26) | (5u << 21) | (5u << 16) | 2u, batch.ops[1]));
    std::memcpy(bytes.data() + used, &fn, sizeof(fn)); used += sizeof(fn);
    const size_t payload = BrowserInteger::PayloadSize(batch.header.count);
    std::memcpy(bytes.data() + used, &batch, payload); used += payload;
  }
};
template <class Loop>
void BuildProgram(Program& program, Fixture& fixture, bool write_pc, bool fail)
{
  program.IntegerRun<Loop>();
  const Operands op{fixture.interpreter, Interpreter::lwz, 0xfffffffc,
                    UGeckoInstruction{(32u << 26) | (3u << 21) | (1u << 16)}};
  program.Add<Operands, Loop>(Loop::template Interpret<false>, op);
  program.Add<Mark, Loop>(GenericCallback, Mark{0x11223344});
  const Operands store{fixture.interpreter, Interpreter::stw, 0x80001234,
    UGeckoInstruction{(36u << 26) | (3u << 21) | ((fail ? 2u : 1u) << 16)}};
  const CheckedOperands checked_store{store, fixture.manager, 17};
  if (write_pc) program.Add<CheckedOperands, Loop>(Loop::template InterpretAndCheckExceptions<true>, checked_store);
  else program.Add<CheckedOperands, Loop>(Loop::template InterpretAndCheckExceptions<false>, checked_store);
  program.Add<Mark, Loop>(GenericCallback, Mark{0x55667788});
  program.Add<EndOperands<false>, Loop>(Loop::template EndBlock<false>, {31, 2, 0});
  program.Add<Mark, Loop>(GenericCallback, Mark{0xbadbad00});
}
int main()
{
  existing_dispatch_regression();
  for (bool write_pc : {false, true})
    for (bool fail : {false, true})
    {
      Fixture expected, actual;
      expected.state.pc = actual.state.pc = 0x80004000;
      expected.state.npc = actual.state.npc = 0x80004004;
      expected.state.gpr[1] = actual.state.gpr[1] = 16;
      expected.state.gpr[2] = actual.state.gpr[2] = 0xfffffffc;
      expected.memory.bytes[16] = actual.memory.bytes[16] = 0x12;
      OriginalLoop original(expected.state); BrowserLoop browser(actual.state);
      Program a, b;
      BuildProgram<OriginalLoop>(a, expected, write_pc, fail);
      BuildProgram<BrowserLoop>(b, actual, write_pc, fail);
      original.m_block_cache.entry = a.bytes.data(); browser.m_block_cache.entry = b.bytes.data();
      PowerPC::monitor_calls.clear(); original.ExecuteOneBlock(); const auto original_monitor = PowerPC::monitor_calls;
      PowerPC::monitor_calls.clear(); browser.ExecuteOneBlock();
      assert(original_monitor == PowerPC::monitor_calls);
      assert(std::memcmp(&expected.state, &actual.state, sizeof(expected.state)) == 0);
      assert(expected.memory.bytes == actual.memory.bytes);
      assert(expected.memory.accesses == actual.memory.accesses);
      assert(expected.manager.checks == actual.manager.checks);
      assert(actual.state.gpr[5] == 3); // Integer-run payload advances to the next callback.
      assert(actual.state.gpr[12] == (fail ? 0x11223344u : 0x55667788u));
      assert(actual.state.downcount == (fail ? 83 : 69));
      assert(actual.manager.checks == (fail ? 1 : 0));
      assert(PowerPC::monitor_calls.size() == (fail ? 0 : 1));
    }
  Fixture missing;
  BrowserLoop browser(missing.state);
  missing.state.pc = 0xdeadbeef;
  browser.ExecuteOneBlock();
  assert(browser.jit_calls == 1 && browser.jit_pc == 0xdeadbeef);
  std::puts("Verified actual native/browser callback-loop distances, exception exits, end-block accounting, integer runs, generic fallback and cache miss");
}
