// Execute the exact production Gate with a controlled, invalidation-aware cache.
#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "Common/CommonTypes.h"
#include "Core/PowerPC/CachedInterpreter/BrowserCompilerGate.h"
namespace PowerPC { struct PowerPCState {
  std::array<u32,32> gpr{};u32 pc=0,npc=0,feature_flags=0;s32 downcount=100;
}; }
namespace CPU { enum class State { Running, Stepping, PowerDown }; }
static unsigned clears=0,releases=0;
static int dweb_browser_compile_request(const char*,u32,u32,u32) { return 1; }
static void dweb_browser_compile_release(u32) { ++releases; }
static void dweb_browser_compile_clear(u32) { ++clears; }
struct CachedInterpreter {
  using AnyCallback=BrowserCompiler::Callback;using BrowserCompilerGate=BrowserCompiler::Gate;
  template<class T>static AnyCallback AnyCallbackCast(s32(*fn)(PowerPC::PowerPCState&,const T&)) { return std::bit_cast<AnyCallback>(fn); }
  BrowserCompiler::Registry m_browser_compiler;
  struct { struct { CPU::State state=CPU::State::Running;
    bool IsStepping() const { return state==CPU::State::Stepping; }
    const CPU::State* GetStatePtr() const { return &state; } } cpu;
    auto& GetCPU() { return cpu; } } m_system;
  struct { std::function<const u8*()> dispatch;unsigned lookups=0;
    const u8* Dispatch() { ++lookups;return dispatch?dispatch():nullptr; } } m_block_cache;
  bool owner=true,debug=false,profile=false;
  bool BrowserCompilerOnOwnerThread() const { return owner; }
  bool IsDebuggingEnabled() const { return debug; }
  bool IsProfilingEnabled() const { return profile; }
  std::string DescribeBrowserCompilerBlock(const BrowserCompilerGate&) const { return "{}"; }
  void DrainBrowserCompiler() { m_browser_compiler.Drain(dweb_browser_compile_release,dweb_browser_compile_clear); }
  static s32 RunBrowserCompilerGate(PowerPC::PowerPCState&,const BrowserCompilerGate&);
};
#include "compiler-execution.h"
struct Operation { u32 next,cycles,flags,marker; };
struct Record { CachedInterpreter::AnyCallback callback;BrowserCompiler::Gate gate;Operation operation;u32 pc,flags;bool live=true; };
static_assert(offsetof(Record,gate)==sizeof(CachedInterpreter::AnyCallback));
struct Fixture {
  CachedInterpreter cached;PowerPC::PowerPCState state;
  std::vector<std::unique_ptr<Record>> records;
  std::function<void(unsigned,const Operation*)> action;
  unsigned calls=0;
  Fixture() {
    cached.m_block_cache.dispatch=[&]() -> const u8* {
      for(auto& r:records)if(r->live&&r->pc==state.pc&&r->flags==state.feature_flags)return reinterpret_cast<const u8*>(r.get());
      return nullptr;
    };
  }
  Record& Add(u32 pc,u32 next,u32 flags=0,u32 flip=0);
  void Retire(Record& record) { record.live=false;cached.m_browser_compiler.Retire(record.gate);cached.DrainBrowserCompiler(); }
  ~Fixture() { for(auto& r:records)cached.m_browser_compiler.Retire(r->gate);cached.DrainBrowserCompiler(); }
};
static Fixture* active=nullptr;
static s32 Compiled(PowerPC::PowerPCState& state,const void* payload) {
  const auto* op=static_cast<const Operation*>(payload);const auto marker=op->marker;
  assert(active->cached.m_browser_compiler.active>0 && marker==0x12345678);
  state.pc=state.npc=op->next;state.downcount-=op->cycles;state.feature_flags^=op->flags;++state.gpr[0];
  ++active->calls;
  if(active->action)active->action(active->calls,op);
  // Retirement and reset may occur above, but this copied payload remains live.
  assert(op->marker==marker);
  return 0;
}
Record& Fixture::Add(u32 pc,u32 next,u32 flags,u32 flip) {
  auto record=std::make_unique<Record>();record->callback=CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserCompilerGate);
  record->pc=pc;record->flags=flags;record->operation={next,1,flip,0x12345678};
  auto& gate=record->gate;gate.owner=&cached;gate.entry=reinterpret_cast<const u8*>(&record->operation);gate.end=gate.entry+sizeof(Operation);
  auto& registry=cached.m_browser_compiler;registry.Add(gate);assert(registry.Retain(gate));gate.job=BrowserCompiler::Job::Queued;++registry.queued;
  assert(registry.Install(&gate,gate.id,gate.epoch,Compiled));
  records.push_back(std::move(record));return *records.back();
}
static void Run(Fixture& f,Record& r) { active=&f;assert(CachedInterpreter::RunBrowserCompilerGate(f.state,r.gate)==0);assert(f.cached.m_browser_compiler.active==0); }
int main() {
  unsigned cases=0;
  for(unsigned length:{1u,2u,31u,32u,33u,65u})for(int budget:{-1,0,1,2,31,32,33,100}) {
    Fixture f;for(unsigned i=0;i<length;++i)f.Add(i,i+1);
    f.state.downcount=budget;Run(f,*f.records[0]);
    // The incoming outer loop always executes its first block, even at<=0.
    const auto expected=std::min({length,32u,static_cast<unsigned>(std::max(1,budget))});
    assert(f.calls==expected && f.state.pc==expected && f.state.npc==expected);
    assert(f.state.downcount==budget-int(expected) && f.state.gpr[0]==expected);
    assert(f.cached.m_browser_compiler.compiled_calls==expected);++cases;
  }
  for(unsigned stop=0;stop<9;++stop) {
    Fixture f;auto& first=f.Add(0,1);auto& second=f.Add(1,2);f.Add(2,3);
    f.action=[&](unsigned call,const Operation*) { if(call!=1)return;
      if(stop==0)f.cached.m_system.cpu.state=CPU::State::PowerDown;
      if(stop==1)f.cached.m_system.cpu.state=CPU::State::Stepping;
      if(stop==2)f.cached.m_browser_compiler.enabled=false;
      if(stop==3)f.cached.owner=false;
      if(stop==4)f.cached.debug=true;
      if(stop==5)f.cached.profile=true;
      if(stop==6)second.gate.compiled=nullptr;
      if(stop==7)second.callback=nullptr;
      if(stop==8)second.gate.owner=nullptr;
    };
    Run(f,first);assert(f.calls==1 && f.state.pc==1);++cases;
  }
  { Fixture f;auto& first=f.Add(0,1,0,1);f.Add(1,99,0);f.Add(1,2,1);Run(f,first);
    assert(f.calls==2 && f.state.pc==2 && f.state.feature_flags==1);++cases; }
  { Fixture f;auto& first=f.Add(0,1);auto& next=f.Add(1,2);
    f.action=[&](unsigned call,const Operation*) { if(call==1){f.Retire(first);f.Retire(next);} };
    Run(f,first);assert(f.calls==1 && !first.gate.retained && !next.gate.retained);++cases; }
  { Fixture f;auto& first=f.Add(0,1);auto& next=f.Add(1,2);const auto before=clears;
    f.action=[&](unsigned call,const Operation*) { if(call==1){f.cached.m_browser_compiler.Reset();f.cached.DrainBrowserCompiler();assert(clears==before);next.gate.job=BrowserCompiler::Job::Rejected;} };
    Run(f,first);assert(f.calls==1 && clears==before+1 && !first.gate.retained);++cases; }
  { Fixture f;auto& first=f.Add(0,1);auto& next=f.Add(1,2);
    f.action=[&](unsigned call,const Operation*) { if(call!=1)return;
      // Reuse the same address while the old generated callback still runs.
      // The next dispatch must observe the newly registered, uncompiled Gate.
      f.Retire(first);f.Retire(next);next.live=true;next.gate=BrowserCompiler::Gate{};
      next.gate.owner=&f.cached;f.cached.m_browser_compiler.Add(next.gate);
      first.gate=BrowserCompiler::Gate{};
    };Run(f,first);assert(f.calls==1 && !next.gate.compiled);++cases; }
  { Fixture f;auto& first=f.Add(0,1);f.Add(77,78);f.action=[&](unsigned call,const Operation*) {
      if(call==1){f.state.pc=f.state.npc=77;f.state.downcount=0;}
    };Run(f,first);assert(f.calls==1 && f.state.pc==77 && f.cached.m_block_cache.lookups==0);++cases; }
  { Fixture f;auto& first=f.Add(0,1);auto& nested=f.Add(50,99);
    f.action=[&](unsigned call,const Operation*) { if(call!=1)return;
      f.state.downcount=1;assert(f.cached.m_browser_compiler.active==1);
      CachedInterpreter::RunBrowserCompilerGate(f.state,nested.gate);
      assert(f.cached.m_browser_compiler.active==1);f.cached.m_browser_compiler.Reset();f.cached.DrainBrowserCompiler();
    };Run(f,first);assert(f.calls==2 && f.state.pc==99 && f.state.downcount==0);++cases; }
  std::printf("Verified %u actual compiled-chain boundaries, stop states, cache/feature changes and active invalidation paths\n",cases);
}
