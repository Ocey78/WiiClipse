// Extracted production descriptor, actual operand layouts and handlers.
#define main existing_dispatch_regression
#include "browser-direct-interpreter-dispatch.cpp"
#undef main
#include <sstream>
#include <string>
#include "Core/PowerPC/CachedInterpreter/BrowserCompilerGate.h"
#include "Core/PowerPC/CachedInterpreter/BrowserIntegerOps.h"
#include "Core/PowerPC/CachedInterpreter/BrowserInterpretOps.h"
#ifdef TEST_BROWSER_COMPILER_END
#include "compiler-descriptor-registers.h"
#endif
static void dweb_browser_compiler_instruction(u32,u32,u32) {}
static unsigned request_calls=0,clear_calls=0;
static int request_result=1;
static int dweb_browser_compile_request(const char*,u32,u32,u32) { ++request_calls;return request_result; }
static void dweb_browser_compile_release(u32) {}
static void dweb_browser_compile_clear(u32) { ++clear_calls; }
template<bool> struct EndOperands;
template<> struct EndOperands<false> { u32 downcount,num_load_stores,num_fp_inst,padding=0; };
struct HaltOperands { PowerPC::PowerPCManager& power_pc;u32 current_pc,downcount; };
struct CachedInterpreter : BrowserCallbacks
{
  using BrowserCompilerGate=BrowserCompiler::Gate;
  template<bool p> using EndBlockOperands=EndOperands<p>;
  using CheckHaltOperands=HaltOperands;
  inline static unsigned fpu_calls=0,end_calls=0;
  inline static bool fpu_unavailable=false;
  static s32 CheckFPU(PowerPC::PowerPCState&,const HaltOperands&) {
    ++fpu_calls;return fpu_unavailable?0:sizeof(AnyCallback)+sizeof(HaltOperands);
  }
  template<class T> static AnyCallback AnyCallbackCast(s32(*fn)(PowerPC::PowerPCState&,const T&)) { return std::bit_cast<AnyCallback>(fn); }
  static s32 RunBrowserIntegerOps(PowerPC::PowerPCState&,const BrowserInteger::Header&) { return 1; }
  static s32 RunBrowserInterpretOps(PowerPC::PowerPCState&,const BrowserInterpret::Header&) { return 2; }
  template<bool p> static s32 EndBlock(PowerPC::PowerPCState&,const EndOperands<p>&) { ++end_calls;return 0; }
  std::string DescribeBrowserCompilerBlock(const BrowserCompilerGate&) const;
  BrowserCompiler::Registry m_browser_compiler;
  struct { struct { bool stepping=false;bool IsStepping() const { return stepping; } } cpu;
    auto& GetCPU() { return cpu; } } m_system;
  bool on_owner=true,debug=false,profile=false;
  mutable unsigned owner_checks=0;
  unsigned fallback_executions=0;
  PowerPC::PowerPCState m_ppc_state;
  bool BrowserCompilerOnOwnerThread() const { ++owner_checks;return on_owner; }
  bool IsDebuggingEnabled() const { return debug; }
  bool IsProfilingEnabled() const { return profile; }
  void ExecuteCallbackStream(const u8*) { ++fallback_executions; }
  void ExecuteActualCallbackStream(const u8*);
  void DrainBrowserCompiler() { m_browser_compiler.Drain(dweb_browser_compile_release,dweb_browser_compile_clear); }
  static s32 RunBrowserCompilerGate(PowerPC::PowerPCState&,const BrowserCompilerGate&);
};
#include "compiler-descriptor.h"
#include "compiler-execution.h"
#ifdef TEST_BROWSER_COMPILER_FAST_GATE
#define DWEB_BROWSER_COMPILER
#include "compiler-loop.h"
#undef DWEB_BROWSER_COMPILER
#endif
struct Program
{
  alignas(16) std::array<u8,4096> bytes{};size_t size=0;
  void AddRaw(CachedInterpreter::AnyCallback fn,const void* operands,size_t length) {
    assert(size+sizeof(fn)+length<=bytes.size());
    std::memcpy(bytes.data()+size,&fn,sizeof(fn));size+=sizeof(fn);
    std::memcpy(bytes.data()+size,operands,length);size+=length;
  }
  template<class T> void Add(s32(*fn)(PowerPC::PowerPCState&,const T&),const T& op) { AddRaw(CachedInterpreter::AnyCallbackCast(fn),&op,sizeof(op)); }
  void End() { Add(CachedInterpreter::EndBlock<false>,EndOperands<false>{17,1,0}); }
};
static s32 Unknown(PowerPC::PowerPCState&,const u32&) { return 37; }
static CachedInterpreter* active_cached=nullptr;
static bool invalidate_during_call=false;
static s32 CompiledSpy(PowerPC::PowerPCState& state,const void* payload) {
  ++state.gpr[2];
  const u8 before=*static_cast<const u8*>(payload);
  if(invalidate_during_call) {
    active_cached->m_browser_compiler.Reset();active_cached->DrainBrowserCompiler();
    assert(*static_cast<const u8*>(payload)==before); // Retained native operands remain live.
  }
  return 0;
}
std::string Describe(CachedInterpreter& cached,Program& program,BrowserCompiler::Registry& registry,BrowserCompiler::Gate& gate) {
  gate.entry=program.bytes.data();gate.end=gate.entry+program.size;
  registry.Add(gate);assert(registry.Retain(gate));
  return cached.DescribeBrowserCompilerBlock(gate);
}
static u32 Address(const void* p) { return static_cast<u32>(reinterpret_cast<uintptr_t>(p)); }
static void ExecuteGate(CachedInterpreter& cached,PowerPC::PowerPCState& state,
                        const BrowserCompiler::Gate& gate) {
  const auto distance=CachedInterpreter::RunBrowserCompilerGate(state,gate);
#ifdef TEST_BROWSER_COMPILER_FAST_GATE
  if(distance) {
    assert(distance==sizeof(CachedInterpreter::AnyCallback)+sizeof(BrowserCompiler::Gate));
    cached.ExecuteCallbackStream(gate.entry); // Original loop continues after the gate record.
  }
#else
  assert(distance==0);
#endif
}
int main()
{
  CachedInterpreter cached;Fixture fixture;
  BrowserCompiler::Registry registry;BrowserCompiler::Gate gate;
  Program program;
  BrowserInteger::Batch integer;
  assert(BrowserInteger::Decode(0x38630001,integer.ops[0]));integer.header.count=1;
  program.AddRaw(CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserIntegerOps),&integer,BrowserInteger::PayloadSize(1));
  const Operands load{fixture.interpreter,Interpreter::lwz,0xfffffffc,UGeckoInstruction{0x80610000}};
  program.Add(CachedInterpreter::Interpret<false>,load);
  program.Add(CachedInterpreter::Interpret<true>,load);
  const CheckedOperands checked{load,fixture.manager,9};
  const size_t checked_offset=program.size+sizeof(CachedInterpreter::AnyCallback);
  program.Add(CachedInterpreter::InterpretAndCheckExceptions<true>,checked);
  program.End();
  const auto json=Describe(cached,program,registry,gate);
  assert(!json.empty());
  assert(json.find("\"role\":\"checked\"")!=std::string::npos);
  assert(json.find("\"role\":\"end\"")!=std::string::npos);
  assert(json.find("\"pc\":null")!=std::string::npos);
  assert(json.find("\"pc\":4294967292")!=std::string::npos);
  assert(json.find("\"gpr\":"+std::to_string(offsetof(PowerPC::PowerPCState,gpr)))!=std::string::npos);
#ifdef TEST_BROWSER_COMPILER_END
  assert(json.find("\"downcount\":"+std::to_string(offsetof(PowerPC::PowerPCState,downcount)))!=std::string::npos);
  assert(json.find("\"mmcr0\":"+std::to_string(offsetof(PowerPC::PowerPCState,spr)+sizeof(u32)*SPR_MMCR0))!=std::string::npos);
  assert(json.find("\"mmcr1\":"+std::to_string(offsetof(PowerPC::PowerPCState,spr)+sizeof(u32)*SPR_MMCR1))!=std::string::npos);
  assert(json.find("\"terminal\":true,\"cycles\":17")!=std::string::npos);
  // No earlier observer receives a terminal-only fast-path cycle field.
  assert(json.find("\"terminal\":false,\"cycles\"")==std::string::npos);
#endif
  assert(json.find("\"payload\":"+std::to_string(Address(gate.retained+checked_offset)))!=std::string::npos);
  assert(json.find("\"payload\":"+std::to_string(Address(gate.entry+checked_offset)))==std::string::npos);
  program.bytes.fill(0);assert(cached.DescribeBrowserCompilerBlock(gate)==json);
  registry.Retire(gate);registry.Drain([](u32){},[](u32){});
#ifdef TEST_BROWSER_COMPILER_FPU
  Program fpu_program;
  const HaltOperands halt{fixture.manager,0x80002200,7};
  fpu_program.Add(CachedInterpreter::CheckFPU,halt);
  fpu_program.Add(CachedInterpreter::Interpret<false>,load);fpu_program.End();
  const auto fpu_json=Describe(cached,fpu_program,registry,gate);
  assert(!fpu_json.empty() && fpu_json.find("\"role\":\"fpu\"")!=std::string::npos);
  assert(fpu_json.find("\"distance\":"+std::to_string(sizeof(CachedInterpreter::AnyCallback)+sizeof(halt)))!=std::string::npos);
  registry.Retire(gate);registry.Drain([](u32){},[](u32){});
#endif
  for(unsigned reject=0;reject<5;++reject) {
    Program bad;
    if(reject==0)bad.Add(Unknown,42u);
    else if(reject==1) {
      auto op=load;op.inst.hex=0x7c0018ac;bad.Add(CachedInterpreter::Interpret<false>,op);
    }
    else if(reject==2) {
      auto op=checked;op.inst.hex=0x7c001bac;bad.Add(CachedInterpreter::InterpretAndCheckExceptions<true>,op);
    }
    else bad.Add(CachedInterpreter::Interpret<false>,load);
    if(reject!=3)bad.End();
    if(reject==4)bad.Add(Unknown,1u); // An early end cannot silently omit trailing records.
    const auto rejected=Describe(cached,bad,registry,gate);assert(rejected.empty());
    registry.Retire(gate);registry.Drain([](u32){},[](u32){});
  }
  Program run;
  BrowserInterpret::Batch batch;batch.header.interpreter=&fixture.interpreter;batch.header.count=2;
  batch.ops[0]={Interpreter::lwz,0x80610000};batch.ops[1]={Interpreter::stw,0x90610004};
  run.AddRaw(CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserInterpretOps),&batch,BrowserInterpret::PayloadSize(2));run.End();
  const auto flat=Describe(cached,run,registry,gate);
#ifdef TEST_BROWSER_COMPILER_RUN
  assert(flat.find("\"role\":\"interpret-run\"")!=std::string::npos);
  assert(flat.find("\"count\":2,\"terminal\":false")!=std::string::npos);
  assert(flat.find("\"distance\":"+std::to_string(sizeof(CachedInterpreter::AnyCallback)+BrowserInterpret::PayloadSize(2)))!=std::string::npos);
  assert(flat.find("\"payload\":"+std::to_string(Address(gate.retained+sizeof(CachedInterpreter::AnyCallback))))!=std::string::npos);
  assert(flat.find("\"kind\":\"instruction\"")==std::string::npos);
  run.bytes.fill(0);assert(cached.DescribeBrowserCompilerBlock(gate)==flat);
#else
  assert(flat.find("\"word\":2153840640")!=std::string::npos);
  assert(flat.find("\"word\":2422276100")!=std::string::npos);
#endif
  registry.Retire(gate);registry.Drain([](u32){},[](u32){});
#ifdef TEST_BROWSER_COMPILER_RUN
  for(unsigned count=1;count<=32;++count) {
    Program preserved;batch.header.interpreter=&fixture.interpreter;batch.header.count=count;
    for(unsigned i=0;i<count;++i)batch.ops[i]={i&1?Interpreter::stw:Interpreter::lwz,i&1?0x90610004u:0x80610000u};
    preserved.AddRaw(CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserInterpretOps),&batch,BrowserInterpret::PayloadSize(count));preserved.End();
    const auto descriptor=Describe(cached,preserved,registry,gate);
    assert(descriptor.find("\"count\":"+std::to_string(count)+",\"terminal\":false")!=std::string::npos);
    assert(descriptor.find("\"handler\":"+std::to_string(static_cast<u32>(reinterpret_cast<uintptr_t>(CachedInterpreter::RunBrowserInterpretOps))))!=std::string::npos);
    registry.Retire(gate);registry.Drain([](u32){},[](u32){});
  }
  for(unsigned reject=0;reject<6;++reject) {
    Program bad;batch.header.interpreter=&fixture.interpreter;batch.header.count=2;
    batch.ops[0]={Interpreter::lwz,0x80610000};batch.ops[1]={Interpreter::stw,0x90610004};
    if(reject==0)batch.header.count=0;
    if(reject==1)batch.header.count=33;
    if(reject==2)batch.header.interpreter=nullptr;
    if(reject==3)batch.ops[1].handler=nullptr;
    if(reject==4)batch.ops[1].instruction=0x7c0018ac;
    bad.AddRaw(CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserInterpretOps),&batch,BrowserInterpret::PayloadSize(reject==5?1:2));
    if(reject!=5)bad.End();
    assert(Describe(cached,bad,registry,gate).empty());
    registry.Retire(gate);registry.Drain([](u32){},[](u32){});
  }
#endif
  // Actual production Gate execution: threshold, capacity before serialization,
  // owner/debug/step guards, compiled dispatch, reset during an active callback.
  Program executable;executable.Add(CachedInterpreter::Interpret<false>,load);executable.End();
  BrowserCompiler::Gate execution_gate;
  execution_gate.owner=&cached;execution_gate.entry=executable.bytes.data();execution_gate.end=execution_gate.entry+executable.size;
  auto& r=cached.m_browser_compiler;r.Add(execution_gate);active_cached=&cached;
  for(unsigned i=0;i<127;++i)ExecuteGate(cached,fixture.state,execution_gate);
  assert(request_calls==0 && cached.fallback_executions==127);
#ifdef TEST_BROWSER_COMPILER_FAST_GATE
  assert(cached.owner_checks==0); // No eligibility lookup until promotion or compiled entry.
#endif
  r.queued=16;
  ExecuteGate(cached,fixture.state,execution_gate);
  assert(request_calls==0 && execution_gate.hits==127 && !execution_gate.retained);
  r.queued=0;
  ExecuteGate(cached,fixture.state,execution_gate);
  assert(request_calls==1 && r.queued==1 && execution_gate.retained);
  assert(r.Install(&execution_gate,execution_gate.id,execution_gate.epoch,CompiledSpy));
  const auto gpr_before=fixture.state.gpr[2];
  ExecuteGate(cached,fixture.state,execution_gate);
  assert(fixture.state.gpr[2]==gpr_before+1 && r.compiled_calls==1);
  for(unsigned boundary=0;boundary<4;++boundary) {
    cached.on_owner=boundary!=0;cached.debug=boundary==1;cached.m_system.cpu.stepping=boundary==2;cached.profile=boundary==3;
    ExecuteGate(cached,fixture.state,execution_gate);
    assert(r.compiled_calls==1);
  }
  cached.on_owner=true;cached.debug=false;cached.m_system.cpu.stepping=false;cached.profile=false;
  invalidate_during_call=true;
  ExecuteGate(cached,fixture.state,execution_gate);
  assert(r.active==0 && r.compiled==0 && !execution_gate.retained && clear_calls==1);
  r.Retire(execution_gate);cached.DrainBrowserCompiler();
#ifdef TEST_BROWSER_COMPILER_FAST_GATE
  // The real loop must advance past the gate, execute the original following
  // load exactly once and stop at EndBlock. A compiled return0 must omit it.
  invalidate_during_call=false;
  Program complete;
  BrowserCompiler::Gate loop_gate;
  complete.Add(CachedInterpreter::RunBrowserCompilerGate,loop_gate);
  const auto native_start=complete.size;
  complete.Add(CachedInterpreter::Interpret<false>,load);complete.End();
  auto& in_place=*reinterpret_cast<BrowserCompiler::Gate*>(complete.bytes.data()+sizeof(CachedInterpreter::AnyCallback));
  in_place.owner=&cached;in_place.entry=complete.bytes.data()+native_start;in_place.end=complete.bytes.data()+complete.size;
  r.Add(in_place);
  for(unsigned mode=0;mode<4;++mode) {
    r.enabled=mode!=0;r.queued=mode==2?16:0;
    in_place.job=mode==1?BrowserCompiler::Job::Rejected:mode==3?BrowserCompiler::Job::Queued:BrowserCompiler::Job::Idle;
    const auto owner_before=cached.owner_checks;
    const auto fallback_before=r.fallback_calls;
    const auto memory_before=fixture.memory.accesses.size();
    const auto end_before=CachedInterpreter::end_calls;
    cached.ExecuteActualCallbackStream(complete.bytes.data());
    assert(r.fallback_calls==fallback_before+1 && cached.owner_checks==owner_before);
    assert(fixture.memory.accesses.size()==memory_before+1);
    assert(CachedInterpreter::end_calls==end_before+1);
  }
  r.queued=0;in_place.job=BrowserCompiler::Job::Idle;r.enabled=true;
  assert(r.Retain(in_place));in_place.job=BrowserCompiler::Job::Queued;r.queued=1;
  assert(r.Install(&in_place,in_place.id,in_place.epoch,CompiledSpy));
  const auto memory_before=fixture.memory.accesses.size();
  const auto compiled_before=r.compiled_calls;
  const auto gpr2_before=cached.m_ppc_state.gpr[2];
  const auto end_before=CachedInterpreter::end_calls;
  cached.ExecuteActualCallbackStream(complete.bytes.data());
  assert(r.compiled_calls==compiled_before+1 && cached.m_ppc_state.gpr[2]==gpr2_before+1);
  assert(fixture.memory.accesses.size()==memory_before);
  assert(CachedInterpreter::end_calls==end_before);
  r.Retire(in_place);cached.DrainBrowserCompiler();
  Program fpu_stream;
  fpu_stream.Add(CachedInterpreter::RunBrowserCompilerGate,loop_gate);
  const auto fpu_start=fpu_stream.size;
  fpu_stream.Add(CachedInterpreter::CheckFPU,HaltOperands{fixture.manager,32,7});
  fpu_stream.Add(CachedInterpreter::Interpret<false>,load);fpu_stream.End();
  auto& fpu_gate=*reinterpret_cast<BrowserCompiler::Gate*>(fpu_stream.bytes.data()+sizeof(CachedInterpreter::AnyCallback));
  fpu_gate.owner=&cached;fpu_gate.entry=fpu_stream.bytes.data()+fpu_start;fpu_gate.end=fpu_stream.bytes.data()+fpu_stream.size;
  r.Add(fpu_gate);r.enabled=false;
  for(bool unavailable:{false,true}) {
    CachedInterpreter::fpu_unavailable=unavailable;
    const auto accesses=fixture.memory.accesses.size();
    const auto ends=CachedInterpreter::end_calls;
    cached.ExecuteActualCallbackStream(fpu_stream.bytes.data());
    assert(fixture.memory.accesses.size()==accesses+(unavailable?0:1));
    assert(CachedInterpreter::end_calls==ends+(unavailable?0:1));
  }
  r.Retire(fpu_gate);cached.DrainBrowserCompiler();
  Program checked_stream;
  checked_stream.Add(CachedInterpreter::RunBrowserCompilerGate,loop_gate);
  const auto checked_start=checked_stream.size;
  checked_stream.Add(CachedInterpreter::InterpretAndCheckExceptions<true>,checked);
  checked_stream.Add(CachedInterpreter::Interpret<false>,load);checked_stream.End();
  auto& checked_gate=*reinterpret_cast<BrowserCompiler::Gate*>(checked_stream.bytes.data()+sizeof(CachedInterpreter::AnyCallback));
  checked_gate.owner=&cached;checked_gate.entry=checked_stream.bytes.data()+checked_start;checked_gate.end=checked_stream.bytes.data()+checked_stream.size;
  r.Add(checked_gate);cached.m_ppc_state.Exceptions=EXCEPTION_DSI;
  const auto accesses=fixture.memory.accesses.size();
  const auto ends=CachedInterpreter::end_calls;
  const auto checks=fixture.manager.checks;
  cached.ExecuteActualCallbackStream(checked_stream.bytes.data());
  assert(fixture.memory.accesses.size()==accesses+1 && CachedInterpreter::end_calls==ends);
  assert(fixture.manager.checks==checks+1); // Actual checked callback stops before trailing records.
  r.Retire(checked_gate);cached.DrainBrowserCompiler();
#endif
  std::puts("Verified actual compiler descriptor and Gate execution: threshold/capacity, retained payloads, PC flags, checked/end whitelist, rejection, owner guards and active reset");
}
