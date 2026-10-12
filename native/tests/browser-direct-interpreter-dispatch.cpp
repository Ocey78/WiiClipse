// Compile with C++20, Source/Core and the extracted headers on the include path.
// Handlers and both cached callback paths are actual pinned source, not a second emulator.
#include <array>
#include <cassert>
#include <bit>
#include <cstdio>
#include <cstring>
#include <type_traits>
#include <vector>
#include "Common/CommonTypes.h"
#include "interpreter-dispatch-instruction.h"

constexpr u32 EXCEPTION_DSI = 0x8;
constexpr u32 EXCEPTION_PROGRAM = 0x80;
constexpr u32 BO_DONT_DECREMENT_FLAG = 4;
constexpr u32 BO_DONT_CHECK_CONDITION = 16;
namespace PowerPC
{
constexpr u32 CR_SO = 1, CR_EQ = 2, CR_GT = 4, CR_LT = 8;
struct ConditionRegister
{
  u32 fields[8]{};
  void SetField(u32 index, u32 value) { fields[index] = value; }
  u32 GetBit(u32 index) const { return (fields[index / 4] >> (3 - index % 4)) & 1; }
};
struct PowerPCState
{
  u32 pc = 0, npc = 0, Exceptions = 0;
  s32 downcount = 100;
  u32 gpr[32]{};
  u32 spr[1024]{};
  ConditionRegister cr;
  struct { bool IR = true; } msr;
  bool xer_so = false;
  u32 sentinels[8]{};
  bool GetXER_SO() const { return xer_so; }
};
struct PowerPCManager
{
  unsigned checks = 0;
  void CheckExceptions() { ++checks; }
};
}
u32& LR(PowerPC::PowerPCState& state) { return state.spr[8]; }
u32& CTR(PowerPC::PowerPCState& state) { return state.spr[9]; }
struct BranchWatch
{
  bool enabled = false;
  std::vector<std::array<u32, 5>> hits;
  bool GetRecordingActive() const { return enabled; }
  void HitTrue(u32 pc, u32 destination, UGeckoInstruction inst, bool ir) { hits.push_back({1, pc, destination, inst.hex, u32(ir)}); }
  void HitFalse(u32 pc, u32 destination, UGeckoInstruction inst, bool ir) { hits.push_back({0, pc, destination, inst.hex, u32(ir)}); }
};
// Memory is the boundary double. Real load/store handlers must pass the correct
// operands, suppress register writes after DSI, and preserve callback exits.
struct Memory
{
  PowerPC::PowerPCState& state;
  std::array<u8, 256> bytes{};
  std::vector<std::array<u32, 3>> accesses;
  template <typename T> T Read(u32 address)
  {
    accesses.push_back({0, address, sizeof(T)});
    if (address > bytes.size() - sizeof(T)) { state.Exceptions |= EXCEPTION_DSI; return 0; }
    T value = 0;
    for (size_t i = 0; i < sizeof(T); ++i) value = T((value << 8) | bytes[address + i]);
    return value;
  }
  template <typename T> void Write(u32 value, u32 address)
  {
    accesses.push_back({1, address, value});
    if (address > bytes.size() - sizeof(T)) { state.Exceptions |= EXCEPTION_DSI; return; }
    for (size_t i = 0; i < sizeof(T); ++i) bytes[address + i] = u8(value >> ((sizeof(T) - 1 - i) * 8));
  }
};
struct Interpreter
{
  using Instruction = void (*)(Interpreter&, UGeckoInstruction);
  PowerPC::PowerPCState& m_ppc_state;
  Memory& m_mmu;
  BranchWatch& m_branch_watch;
  bool m_end_block = false;
  template <typename T> static void Helper_IntCompare(PowerPC::PowerPCState&, UGeckoInstruction, T, T);
  static void cmpi(Interpreter&, UGeckoInstruction);
  static void cmpli(Interpreter&, UGeckoInstruction);
  static void bx(Interpreter&, UGeckoInstruction);
  static void bcx(Interpreter&, UGeckoInstruction);
  static void lwz(Interpreter&, UGeckoInstruction);
  static void stw(Interpreter&, UGeckoInstruction);
  static void lwzu(Interpreter&, UGeckoInstruction);
};
#include "interpreter-dispatch-handlers.h"
#include "interpreter-dispatch-helper.h"
struct ReferenceEntry { u32 opcode; Interpreter::Instruction handler; };
#include "interpreter-dispatch-table.h"

struct Operands
{
  Interpreter& interpreter;
  Interpreter::Instruction func;
  u32 current_pc;
  UGeckoInstruction inst;
};
struct CheckedOperands : Operands { PowerPC::PowerPCManager& power_pc; u32 downcount; };
#define DECLARE_CALLBACKS(name) struct name { \
  using AnyCallback = s32 (*)(PowerPC::PowerPCState&, const void*); \
  using InterpretOperands = Operands; using InterpretAndCheckExceptionsOperands = CheckedOperands; \
  template <bool write_pc> static s32 Interpret(PowerPC::PowerPCState&, const Operands&); \
  template <bool write_pc> static s32 InterpretAndCheckExceptions(PowerPC::PowerPCState&, const CheckedOperands&); };
DECLARE_CALLBACKS(OriginalCallbacks)
DECLARE_CALLBACKS(BrowserCallbacks)
#undef DECLARE_CALLBACKS

// Compile the exact same extracted callback bodies in native and browser modes.
#ifdef __EMSCRIPTEN__
#undef __EMSCRIPTEN__
#endif
#define CachedInterpreter OriginalCallbacks
#include "interpreter-dispatch-callbacks.h"
#undef CachedInterpreter
#define __EMSCRIPTEN__ 1
#define CachedInterpreter BrowserCallbacks
#include "interpreter-dispatch-callbacks.h"
#undef CachedInterpreter

static unsigned checked = 0;
void CustomFallback(Interpreter& interpreter, UGeckoInstruction inst)
{
  auto& state = interpreter.m_ppc_state;
  state.gpr[7] = inst.hex;
  state.Exceptions |= EXCEPTION_PROGRAM;
}
struct Fixture
{
  PowerPC::PowerPCState state{};
  Memory memory{state};
  BranchWatch watch;
  PowerPC::PowerPCManager manager;
  Interpreter interpreter{state, memory, watch};
};
template <bool write_pc, bool check_exceptions>
void Check(u32 word, Interpreter::Instruction handler, const Fixture& seed)
{
  Fixture expected, actual;
  expected.state = actual.state = seed.state;
  expected.memory.bytes = actual.memory.bytes = seed.memory.bytes;
  expected.watch.enabled = actual.watch.enabled = seed.watch.enabled;
  const u32 current_pc = 0xfffffffc;
  const Operands original{expected.interpreter, handler, current_pc, UGeckoInstruction{word}};
  const Operands browser{actual.interpreter, handler, current_pc, UGeckoInstruction{word}};
  s32 expected_distance, actual_distance;
  if constexpr (check_exceptions)
  {
    const CheckedOperands a{original, expected.manager, 17}, b{browser, actual.manager, 17};
    expected_distance = OriginalCallbacks::InterpretAndCheckExceptions<write_pc>(expected.state, a);
    actual_distance = BrowserCallbacks::InterpretAndCheckExceptions<write_pc>(actual.state, b);
  }
  else
  {
    expected_distance = OriginalCallbacks::Interpret<write_pc>(expected.state, original);
    actual_distance = BrowserCallbacks::Interpret<write_pc>(actual.state, browser);
  }
  assert(expected_distance == actual_distance);
  assert(std::memcmp(&expected.state, &actual.state, sizeof(expected.state)) == 0);
  assert(expected.memory.bytes == actual.memory.bytes);
  assert(expected.memory.accesses == actual.memory.accesses);
  assert(expected.watch.hits == actual.watch.hits);
  assert(expected.manager.checks == actual.manager.checks);
  assert(expected.interpreter.m_end_block == actual.interpreter.m_end_block);
  if constexpr (check_exceptions)
  {
    if (actual.state.Exceptions & (EXCEPTION_DSI | EXCEPTION_PROGRAM))
    {
      assert(actual_distance == 0);
      assert(actual.state.pc == current_pc);
      assert(actual.state.downcount == seed.state.downcount - 17);
      assert(actual.manager.checks == 1);
    }
  }
  if constexpr (write_pc)
    if (handler != Interpreter::bx && handler != Interpreter::bcx)
      assert(actual.state.npc == 0); // current_pc + 4 wraps exactly as upstream.
  ++checked;
}
void AllPaths(u32 word, Interpreter::Instruction handler, const Fixture& seed)
{
  Check<false, false>(word, handler, seed);
  Check<true, false>(word, handler, seed);
  Check<false, true>(word, handler, seed);
  Check<true, true>(word, handler, seed);
}
int main()
{
  Fixture seed;
  seed.state.pc = 0x80004000; seed.state.npc = 0x12345678;
  for (u32 i = 0; i < 32; ++i) seed.state.gpr[i] = 16 + i;
  for (u32 i = 0; i < seed.memory.bytes.size(); ++i) seed.memory.bytes[i] = u8(i);
  for (u32 flags : {0u, EXCEPTION_DSI, EXCEPTION_PROGRAM})
    for (bool so : {false, true})
      for (bool watching : {false, true})
      {
        seed.state.Exceptions = flags; seed.state.xer_so = so; seed.watch.enabled = watching;
        for (const auto& entry : primary)
          for (u32 reg : {0u, 1u, 31u})
            for (u32 immediate : {0u, 1u, 0x7fffu, 0x8000u, 0xffffu})
              AllPaths((entry.opcode << 26) | (reg << 21) | (reg << 16) | immediate, entry.handler, seed);
      }
  seed.state.Exceptions = 0;
  for (u32 ctr : {0u, 1u, 2u, 0xffffffffu})
    for (u32 bo = 0; bo < 32; ++bo)
      for (u32 bi = 0; bi < 32; ++bi)
        for (u32 cr : {0u, 15u})
          for (u32 branch_bits = 0; branch_bits < 4; ++branch_bits)
          {
            CTR(seed.state) = ctr;
            for (auto& field : seed.state.cr.fields) field = cr;
            AllPaths((16u << 26) | (bo << 21) | (bi << 16) | 0xfffc | branch_bits, Interpreter::bcx, seed);
          }
  // Unsupported real primary instruction stays on the original callback.
  AllPaths((33u << 26) | (1u << 21) | (1u << 16) | 4u, Interpreter::lwzu, seed);
  // Preserve supplied callbacks even for supported primary opcodes, and invalid PC/address operands.
  for (u32 opcode : {0u, 10u, 11u, 16u, 18u, 32u, 36u, 63u}) AllPaths(opcode << 26, CustomFallback, seed);
  seed.state.gpr[1] = 0xfffffffc;
  seed.state.gpr[2] = 0x11223344;
  for (u32 opcode : {32u, 36u})
    AllPaths((opcode << 26) | (2u << 21) | (1u << 16), opcode == 32 ? Interpreter::lwz : Interpreter::stw, seed);
  std::printf("Verified %u original/browser cached callback paths, handlers and exception boundaries\n", checked);
}
