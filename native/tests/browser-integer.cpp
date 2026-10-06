// Differential checks against code extracted from Dolphin's pinned interpreter.
// Build with C++20, Source/Core and the generated reference header on the include path.
#include <array>
#include <cassert>
#include <bit>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

#include "Core/PowerPC/CachedInterpreter/BrowserIntegerOps.h"

struct TestState
{
  u32 before[4];
  u32 gpr[32];
  u32 after[16];
  void SetXER_OV(bool) { std::abort(); }
};
#include "integer-reference.h"

namespace PowerPC { using PowerPCState = TestState; }
// The implementations below are extracted verbatim from the patched interpreter
// and its emitter. This fixture supplies only the surrounding heavyweight types.
class CachedInterpreterEmitter
{
public:
  using AnyCallback = s32 (*)(TestState&, const void*);
  template<class Operands>
  static AnyCallback AnyCallbackCast(s32 (*callback)(TestState&, const Operands&))
  { return std::bit_cast<AnyCallback>(callback); }
  void Write(AnyCallback, const void*, std::size_t);
  u8* m_code = nullptr;
  u8* m_code_end = nullptr;
  bool m_write_failed = false;
};
class CachedInterpreter : public CachedInterpreterEmitter
{
public:
  BrowserInteger::Batch m_browser_integer_batch{};
  static s32 RunBrowserIntegerOps(TestState&, const BrowserInteger::Header&);
  bool AppendBrowserIntegerOp(u32, u32);
  void FlushBrowserIntegerOps();
};
#define DEBUG_ASSERT(condition) assert(condition)
#include "integer-batch-reference.h"
#undef DEBUG_ASSERT

static std::mt19937 random_state(0x57494943);
static u64 checked = 0;

static ReferenceHandler Reference(u32 word)
{
  const UGeckoInstruction inst{word};
  if (inst.OPCD == 31)
  {
    if (inst.Rc)
      return nullptr;
    for (const auto& entry : table31)
    {
      if (entry.opcode == inst.SUBOP10)
      {
        // These four families also have OE variants in the upstream table.
        if (inst.OE && (entry.handler == Interpreter::addx ||
                        entry.handler == Interpreter::mullwx ||
                        entry.handler == Interpreter::negx ||
                        entry.handler == Interpreter::subfx))
          return nullptr;
        return entry.handler;
      }
    }
    return nullptr;
  }
  if ((inst.OPCD == 20 || inst.OPCD == 21 || inst.OPCD == 23) && inst.Rc)
    return nullptr;
  for (const auto& entry : primary)
    if (entry.opcode == inst.OPCD)
      return entry.handler;
  return nullptr;
}

static void Fail(const char* reason, u32 word)
{
  std::fprintf(stderr, "%s: instruction %08x after %llu checks\n", reason, word,
               static_cast<unsigned long long>(checked));
  std::exit(1);
}

static void Check(u32 word, u32 edge = 0, bool use_edge = false)
{
  BrowserInteger::Op op{};
  const bool accepted = BrowserInteger::Decode(word, op);
  const auto reference = Reference(word);
  if (accepted != (reference != nullptr))
    Fail("Decoder accepted a different instruction set", word);
  ++checked;
  if (!accepted)
    return;
  TestState expected{}, actual{};
  for (auto& value : expected.before) value = random_state();
  for (auto& value : expected.gpr) value = use_edge ? edge : random_state();
  for (auto& value : expected.after) value = random_state();
  actual = expected;
  Interpreter interpreter{expected};
  reference(interpreter, UGeckoInstruction{word});
  BrowserInteger::Execute(actual.gpr, &op, 1);
  if (std::memcmp(&expected, &actual, sizeof(actual)))
    Fail("Register/state mismatch against upstream handler", word);
}

int main()
{
  constexpr u32 edges[] = {0, 1, 31, 32, 63, 64, 0x7fffffff, 0x80000000,
                           0x80000001, 0xfffffffe, 0xffffffff, 0x55555555, 0xaaaaaaaa};
  // Every primary opcode, XO opcode, Rc/OE combination and register alias class.
  for (u32 primary_opcode = 0; primary_opcode < 64; ++primary_opcode)
    for (u32 low = 0; low < 2048; ++low)
      for (u32 registers : {0u, 0x03fff800u, 0x01294000u, 0x02000800u})
        Check((primary_opcode << 26) | registers | low);

  // Signed/unsigned immediate boundaries, RA=0, every destination/source alias.
  for (const auto& entry : primary)
    for (u32 dst = 0; dst < 32; ++dst)
      for (u32 src = 0; src < 32; ++src)
        for (u32 imm : {0u, 1u, 0x7fffu, 0x8000u, 0xffffu})
          for (u32 value : edges)
            Check((entry.opcode << 26) | (dst << 21) | (src << 16) | imm, value, true);

  // All 32x32x32 rotate masks and shifts, including wrapping masks and shift zero.
  for (u32 opcode : {20u, 21u, 23u})
    for (u32 mb = 0; mb < 32; ++mb)
      for (u32 me = 0; me < 32; ++me)
        for (u32 shift = 0; shift < 32; ++shift)
          for (u32 value : edges)
            Check((opcode << 26) | (4 << 21) | (4 << 16) | (shift << 11) |
                  (mb << 6) | (me << 1), value, true);

  // Arbitrary bit patterns validate rejection as well as supported arithmetic.
  for (unsigned i = 0; i < 250000; ++i) Check(random_state());

  // Dependent runs check write-after-read aliases and register changes between ops.
  std::vector<u32> words;
  for (const auto& entry : primary) words.push_back(entry.opcode << 26);
  for (const auto& entry : table31) words.push_back((31u << 26) | (entry.opcode << 1));
  for (unsigned run = 0; run < 10000; ++run)
  {
    TestState expected{}, actual{};
    for (auto& value : expected.gpr) value = random_state();
    actual = expected;
    Interpreter interpreter{expected};
    std::array<BrowserInteger::Op, 32> ops{};
    const auto count = run % 33;
    for (unsigned i = 0; i < count; ++i)
    {
      u32 word;
      ReferenceHandler reference;
      do
      {
        word = words[random_state() % words.size()];
        word |= random_state() & ((word >> 26) == 31 ? 0x03fff800u : 0x03fffffeu);
        reference = Reference(word);
      } while (!reference);
      if (!BrowserInteger::Decode(word, ops[i])) Fail("Run decode rejected", word);
      reference(interpreter, UGeckoInstruction{word});
    }
    BrowserInteger::Execute(actual.gpr, ops.data(), count);
    if (std::memcmp(&expected, &actual, sizeof(actual))) Fail("Dependent run mismatch", run);
    checked += count;
  }

  // Serializing, flushing and executing the real batch methods must visit each
  // instruction exactly once, including full runs and noncontiguous guest PCs.
  for (u32 count = 0; count <= 96; ++count)
  {
    alignas(16) std::array<u8, 4096> code{};
    CachedInterpreter cached;
    cached.m_code = code.data();
    cached.m_code_end = code.data() + code.size();
    TestState expected{}, actual{};
    Interpreter interpreter{expected};
    for (u32 i = 0; i < count; ++i)
    {
      const u32 word = (14u << 26) | (3u << 21) | (3u << 16) | (i + 1);
      if (!cached.AppendBrowserIntegerOp(word, 0x80003000 + i * 4 + (i >= 40 ? 64 : 0)))
        Fail("Batch refused addi", word);
      Interpreter::addi(interpreter, UGeckoInstruction{word});
    }
    cached.FlushBrowserIntegerOps();
    if (cached.m_write_failed || cached.m_browser_integer_batch.header.count)
      Fail("Flush failed", count);
    u32 executed = 0;
    for (const u8* cursor = code.data(); cursor < cached.m_code;)
    {
      using Callback = CachedInterpreterEmitter::AnyCallback;
      const auto callback = *reinterpret_cast<const Callback*>(cursor);
      const auto* payload = cursor + sizeof(Callback);
      const auto* header = reinterpret_cast<const BrowserInteger::Header*>(payload);
      if (!header->count || header->count > 32 ||
          header->first_pc != 0x80003000 + executed * 4 + (executed >= 40 ? 64 : 0))
        Fail("Batch boundary/PC mismatch", count);
      executed += header->count;
      const auto distance = callback(actual, payload);
      if (distance != sizeof(Callback) + BrowserInteger::PayloadSize(header->count) ||
          cursor + distance > cached.m_code)
        Fail("Invalid variable callback distance", count);
      cursor += distance;
    }
    if (executed != count || std::memcmp(&expected, &actual, sizeof(actual)))
      Fail("Serialized run mismatch", count);
  }
  {
    alignas(16) std::array<u8, 16> code{};
    CachedInterpreter cached;
    cached.m_code = code.data();
    cached.m_code_end = code.data() + code.size();
    cached.AppendBrowserIntegerOp(14u << 26, 0x80003000);
    cached.FlushBrowserIntegerOps();
    if (!cached.m_write_failed || cached.m_code != code.data() ||
        cached.m_browser_integer_batch.header.count != 0)
      Fail("Emitter overflow was not contained", 0);
    for (const auto byte : code)
      if (byte != 0) Fail("Emitter overflow changed storage", 0);
  }
  std::printf("Decoded integer runs match %llu upstream differential cases\n",
              static_cast<unsigned long long>(checked));
}
