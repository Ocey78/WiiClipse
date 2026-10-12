// Differential test of the source-extracted MMU entry points and hardware routes.
// Only external memory/debugger/device boundaries are test doubles.
#include <array>
#include <bit>
#include <cassert>
#include <concepts>
#include <cstdio>
#include <cstring>
#include <type_traits>
#include <vector>
#include "Common/CommonTypes.h"
namespace Common
{
template <class T> using MakeAtLeastU32 = std::conditional_t<(sizeof(T) < 4), u32, T>;
u16 swap16(u16 v) { return u16((v >> 8) | (v << 8)); }
u32 swap32(u32 v) { return (v >> 24) | ((v >> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24); }
u64 swap64(u64 v) { return (u64(swap32(u32(v))) << 32) | swap32(u32(v >> 32)); }
template <class T> T AlignDown(T v, size_t n) { return T(v & ~(n - 1)); }
template <class T> T AlignUp(T v, size_t n) { return AlignDown(T(v + n - 1), n); }
}
#include "ram-fastpath-constants.h"
constexpr u32 EXCEPTION_DSI = 8, EXCEPTION_FAKE_MEMCHECK_HIT = 0x200;
#include "ram-fastpath-flags.h"
#include "ram-fastpath-helpers.h"
struct Event
{
  unsigned kind; u32 address; u64 value; size_t size;
  bool operator==(const Event&) const = default;
};
namespace ProcessorInterface { constexpr unsigned INT_CAUSE_PI = 1; }
namespace GPFifo { constexpr u32 GATHER_PIPE_PHYSICAL_ADDRESS = 0x0c008000; }
struct Device
{
  std::vector<Event>* events;
  void Write8(u8 v) { events->push_back({1, 0, v, 1}); }
  void Write16(u16 v) { events->push_back({1, 0, v, 2}); }
  void Write32(u32 v) { events->push_back({1, 0, v, 4}); }
  void SetInterrupt(unsigned v) { events->push_back({2, 0, v, 0}); }
};
struct CPU { unsigned breaks = 0; void Break() { ++breaks; } };
struct System
{
  std::vector<Event> events;
  CPU cpu; bool pause = true;
  Device device{&events};
  Device& GetProcessorInterface() { return device; }
  Device& GetGPFifo() { return device; }
  CPU& GetCPU() { return cpu; }
  bool IsPauseOnPanicMode() { return pause; }
};
System* active_system;
u32 EFB_Read(u32 address) { active_system->events.push_back({3, address, 0, 4}); return 0x56781234; }
void EFB_Write(u32 value, u32 address) { active_system->events.push_back({4, address, value, 4}); }
#define PanicAlertFmt(...) active_system->events.push_back({5, 0, 0, 0})
#define DEBUG_ASSERT(v) assert(v)
struct MMIO
{
  template <class T> T Read(System& s, u32 a) { s.events.push_back({6, a, 0, sizeof(T)}); return T(0x76543210); }
  template <class T> void Write(System& s, u32 a, T v) { s.events.push_back({7, a, v, sizeof(T)}); }
};
struct Memory
{
  static constexpr u32 allocated = 0x40000;
  std::vector<u8> ram = std::vector<u8>(allocated + 8), ex = ram, l1 = ram, fake = ram;
  u32 ram_size = 0x30003, ex_size = 0x30003;
  bool have_ram = true, have_ex = true, have_l1 = true, have_fake = true;
  MMIO mmio;
  Memory() { for (u32 i = 0; i < ram.size(); ++i) ram[i] = u8(i * 13 + 7); ex = l1 = fake = ram; }
  u8* GetRAM() { return have_ram ? ram.data() : nullptr; }
  u8* GetEXRAM() { return have_ex ? ex.data() : nullptr; }
  u8* GetL1Cache() { return have_l1 ? l1.data() : nullptr; }
  u8* GetFakeVMEM() { return have_fake ? fake.data() : nullptr; }
  u32 GetRamSizeReal() { return ram_size; }
  u32 GetExRamSizeReal() { return ex_size; }
  u32 GetRamMask() { return allocated - 1; }
  u32 GetL1CacheSize() { return allocated; }
  u32 GetFakeVMemMask() { return allocated - 1; }
  MMIO* GetMMIOMapping() { return &mmio; }
};
struct Cache
{
  unsigned reads = 0, writes = 0;
  bool last_lock = false;
  void Read(Memory& m, u32 a, void* out, size_t n, bool lock)
  { ++reads; last_lock = lock; std::memcpy(out, ((a >> 28) == 1 ? m.GetEXRAM() : m.GetRAM()) + (a & 0xfffffff), n); }
  void Write(Memory& m, u32 a, const void* in, size_t n, bool lock)
  { ++writes; last_lock = lock; std::memcpy(((a >> 28) == 1 ? m.GetEXRAM() : m.GetRAM()) + (a & 0xfffffff), in, n); }
};
struct Bit { bool value = true; bool Value() const { return value; } operator bool() const { return value; } };
struct State
{
  struct { Bit DR, IR; } msr;
  bool m_enable_dcache = false, locked = false;
  Cache dCache;
  u32 pc = 0x80001234, Exceptions = 0;
};
struct HID0 { bool DLOCK; explicit HID0(State& s) : DLOCK(s.locked) {} };
struct Checks { bool enabled = false; bool HasAny() const { return enabled; } };
struct PowerPCManager { Checks checks; Checks& GetMemChecks() { return checks; } };
struct Translation { u32 address; bool wi, success; bool Success() const { return success; } };
#define DECLARE_MMU(name) struct name { \
  System m_system; Memory m_memory; State m_ppc_state; PowerPCManager m_power_pc; BatTable m_dbat_table{}; \
  unsigned slow_reads = 0, slow_writes = 0; bool page_mapping = false, watch_fault = false; \
  name() { for (u32 a = 0; a < Memory::allocated; a += BAT_PAGE_SIZE) { \
    m_dbat_table[(0x80000000u + a) >> BAT_INDEX_SHIFT] = a | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT; \
    m_dbat_table[(0x90000000u + a) >> BAT_INDEX_SHIFT] = (0x10000000u + a) | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT; }} \
  template <std::unsigned_integral T> u8* GetBrowserRAMPointer(u32); \
  template <XCheckTLBFlag flag> Translation TranslateAddress(u32 a) { \
    bool wi = false; if (TranslateBatAddress(m_dbat_table, &a, &wi)) return {a, wi, true}; \
    return {a & (Memory::allocated - 1), false, page_mapping}; } \
  void GenerateDSIException(u32 a, bool write) { m_ppc_state.Exceptions |= EXCEPTION_DSI; m_system.events.push_back({8, a, write, 0}); } \
  void Memcheck(u32 a, u64 v, bool write, size_t n) { if (m_power_pc.checks.enabled) { \
    m_system.events.push_back({unsigned(write ? 10 : 9), a, v, n}); if (watch_fault) m_ppc_state.Exceptions |= EXCEPTION_DSI; }} \
  template <XCheckTLBFlag flag, std::unsigned_integral T, bool never_translate = false> T ReadFromHardwareBody(u32); \
  template <XCheckTLBFlag flag, bool never_translate = false> void WriteToHardwareBody(u32, u32, u32); \
  template <XCheckTLBFlag flag, std::unsigned_integral T, bool never_translate = false> T ReadFromHardware(u32 a) { \
    ++slow_reads; return ReadFromHardwareBody<flag, T, never_translate>(a); } \
  template <XCheckTLBFlag flag, bool never_translate = false> void WriteToHardware(u32 a, u32 v, u32 n) { \
    ++slow_writes; WriteToHardwareBody<flag, never_translate>(a, v, n); } \
  template <std::unsigned_integral T> T Read(u32); \
  template <std::unsigned_integral T> void Write(Common::MakeAtLeastU32<T>, u32); };
DECLARE_MMU(NativeMMU)
DECLARE_MMU(BrowserMMU)
#undef DECLARE_MMU
#undef __EMSCRIPTEN__
#define MMU NativeMMU
#include "ram-fastpath-methods.h"
#undef MMU
#define __EMSCRIPTEN__ 1
#define MMU BrowserMMU
#include "ram-fastpath-methods.h"
#undef MMU

unsigned cases = 0;
void Equivalent(const NativeMMU& a, const BrowserMMU& b)
{
  assert(a.m_memory.ram == b.m_memory.ram && a.m_memory.ex == b.m_memory.ex);
  assert(a.m_memory.l1 == b.m_memory.l1 && a.m_memory.fake == b.m_memory.fake);
  assert(a.m_system.events == b.m_system.events);
  assert(a.m_system.cpu.breaks == b.m_system.cpu.breaks);
  assert(a.m_ppc_state.Exceptions == b.m_ppc_state.Exceptions);
  assert(a.m_ppc_state.dCache.reads == b.m_ppc_state.dCache.reads);
  assert(a.m_ppc_state.dCache.writes == b.m_ppc_state.dCache.writes);
  assert(a.m_ppc_state.dCache.last_lock == b.m_ppc_state.dCache.last_lock);
}
template <class T, class Configure> void Check(u32 address, bool fast, Configure configure)
{
  NativeMMU a; BrowserMMU b;
  configure(a); configure(b);
  active_system = &a.m_system; T expected = a.template Read<T>(address);
  active_system = &b.m_system; T actual = b.template Read<T>(address);
  assert(expected == actual); Equivalent(a, b);
  if (fast)
  {
    bool wi = false; u32 physical = address;
    assert(TranslateBatAddress(b.m_dbat_table, &physical, &wi) && !wi);
    const auto& bytes = (physical >> 28) == 1 ? b.m_memory.ex : b.m_memory.ram;
    u64 assembled = 0;
    for (size_t i = 0; i < sizeof(T); ++i) assembled = (assembled << 8) | bytes[(physical & 0xfffffff) + i];
    assert(actual == assembled);
  }
  assert(a.slow_reads > 0);
  assert((b.slow_reads == 0) == fast);
  constexpr Common::MakeAtLeastU32<T> value = Common::MakeAtLeastU32<T>(0x11223344aabbccddull);
  active_system = &a.m_system; a.template Write<T>(value, address);
  active_system = &b.m_system; b.template Write<T>(value, address);
  Equivalent(a, b);
  if (fast)
  {
    bool wi = false; u32 physical = address;
    assert(TranslateBatAddress(b.m_dbat_table, &physical, &wi) && !wi);
    const auto& bytes = (physical >> 28) == 1 ? b.m_memory.ex : b.m_memory.ram;
    for (size_t i = 0; i < sizeof(T); ++i)
      assert(bytes[(physical & 0xfffffff) + i] == u8(value >> (8 * (sizeof(T) - 1 - i))));
  }
  assert(a.slow_writes > 0);
  // u64 stores retain the original two independently translated writes.
  assert((b.slow_writes == 0) == (fast && sizeof(T) <= 4));
  ++cases;
}
template <class T> void Width()
{
  const auto unchanged = [](auto&) {};
  for (u32 bank : {0x80000000u, 0x90000000u})
  {
    for (u32 offset : {0u, 8u, 0xff8u, BAT_PAGE_SIZE - 8, BAT_PAGE_SIZE, 0x30000u - 8})
      Check<T>(bank + offset, true, unchanged);
    Check<T>(bank + 0x30000u, sizeof(T) <= 2, unchanged);
    Check<T>(bank + 0x30008u, false, unchanged);
    Check<T>(bank + 0x10u, false, [](auto& m) { m.m_ppc_state.m_enable_dcache = true; m.m_ppc_state.locked = true; });
    Check<T>(bank + 0x10u, false, [](auto& m) { m.m_power_pc.checks.enabled = true; m.watch_fault = true; });
    Check<T>(bank + 0x10u, false, [bank](auto& m) { m.m_dbat_table[bank >> BAT_INDEX_SHIFT] &= ~BAT_PHYSICAL_BIT; });
    Check<T>(bank + 0x10u, false, [bank](auto& m) { m.m_dbat_table[bank >> BAT_INDEX_SHIFT] |= BAT_WI_BIT; });
    if constexpr (sizeof(T) > 1)
    {
      Check<T>(bank + 1, false, unchanged);
      Check<T>(bank + 0xfff, false, unchanged);
      Check<T>(bank + BAT_PAGE_SIZE - 1, false, unchanged);
    }
  }
  Check<T>(0x10, false, [](auto& m) { m.m_ppc_state.msr.DR.value = false; });
  Check<T>(0x80000010, false, [](auto& m) { m.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = 0; });
  Check<T>(0x80000010, false, [](auto& m) { m.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = 0; m.page_mapping = true; });
  for (u32 physical : {0x08000000u, 0x0c000000u, 0x0c008000u, 0xe0000000u, 0x7e000000u, 0x00400000u, 0x20000000u})
    Check<T>(0x80000010, false, [physical](auto& m) { m.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = physical | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT; });
  // Even an oversized RAM override must preserve the original device priority.
  // The probe rejects before dereferencing: the fixture need not allocate 256 MB.
  {
    BrowserMMU b;
    b.m_memory.ram_size = 0x10000000;
    b.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = 0x08000000 | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT;
    assert(b.template GetBrowserRAMPointer<T>(0x80000010) == nullptr);
  }
  Check<T>(0x80000010, false, [](auto& m) { m.m_memory.ram_size = 0x10000000;
    m.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = 0x08000000 | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT; });
  Check<T>(0x80000010, false, [](auto& m) { m.m_memory.have_ram = false; });
  Check<T>(0x90000010, false, [](auto& m) { m.m_memory.have_ex = false; });
  if constexpr (sizeof(T) > 1) Check<T>(0xffffffff, false, unchanged);
  // Replacing an existing BAT entry must immediately affect the next access.
  Check<T>(0x80000010, true, [](auto& m) { m.m_dbat_table[0x80000000u >> BAT_INDEX_SHIFT] = BAT_PAGE_SIZE | BAT_MAPPED_BIT | BAT_PHYSICAL_BIT; });
}
int main()
{
  Width<u8>(); Width<u16>(); Width<u32>(); Width<u64>();
  std::printf("Browser RAM fast path: %u differential cases, original hardware routes and side effects match\n", cases);
  return 0;
}
