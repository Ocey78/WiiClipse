// Extracted production descriptor, actual operand layouts and handlers.
#define main existing_dispatch_regression
#include "browser-direct-interpreter-dispatch.cpp"
#undef main
#include <sstream>
#include <string>
#include "Core/PowerPC/CachedInterpreter/BrowserCompilerGate.h"
#include "Core/PowerPC/CachedInterpreter/BrowserIntegerOps.h"
#include "Core/PowerPC/CachedInterpreter/BrowserInterpretOps.h"
static void dweb_browser_compiler_instruction(u32,u32,u32) {}
static unsigned request_calls=0,clear_calls=0;
static int request_result=1;
static int dweb_browser_compile_request(const char*,u32,u32,u32) { ++request_calls;return request_result; }
static void dweb_browser_compile_release(u32) {}
static void dweb_browser_compile_clear(u32) { ++clear_calls; }
template<bool> struct EndOperands;
template<> struct EndOperands<false> { u32 downcount,num_load_stores,num_fp_inst,padding=0; };
struct CachedInterpreter : BrowserCallbacks
{
  using BrowserCompilerGate=BrowserCompiler::Gate;
  template<bool p> using EndBlockOperands=EndOperands<p>;
  template<class T> static AnyCallback AnyCallbackCast(s32(*fn)(PowerPC::PowerPCState&,const T&)) { return std::bit_cast<AnyCallback>(fn); }
  static s32 RunBrowserIntegerOps(PowerPC::PowerPCState&,const BrowserInteger::Header&) { return 1; }
  static s32 RunBrowserInterpretOps(PowerPC::PowerPCState&,const BrowserInterpret::Header&) { return 2; }
  template<bool p> static s32 EndBlock(PowerPC::PowerPCState&,const EndOperands<p>&) { return 0; }
  std::string DescribeBrowserCompilerBlock(const BrowserCompilerGate&) const;
  BrowserCompiler::Registry m_browser_compiler;
  struct { struct { bool stepping=false;bool IsStepping() const { return stepping; } } cpu;
    auto& GetCPU() { return cpu; } } m_system;
  bool on_owner=true,debug=false,profile=false;
  unsigned fallback_executions=0;
  bool BrowserCompilerOnOwnerThread() const { return on_owner; }
  bool IsDebuggingEnabled() const { return debug; }
  bool IsProfilingEnabled() const { return profile; }
  void ExecuteCallbackStream(const u8*) { ++fallback_executions; }
  void DrainBrowserCompiler() { m_browser_compiler.Drain(dweb_browser_compile_release,dweb_browser_compile_clear); }
  static s32 RunBrowserCompilerGate(PowerPC::PowerPCState&,const BrowserCompilerGate&);
};
#include "compiler-descriptor.h"
#include "compiler-execution.h"
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
  assert(json.find("\"payload\":"+std::to_string(Address(gate.retained+checked_offset)))!=std::string::npos);
  assert(json.find("\"payload\":"+std::to_string(Address(gate.entry+checked_offset)))==std::string::npos);
  program.bytes.fill(0);assert(cached.DescribeBrowserCompilerBlock(gate)==json);
  registry.Retire(gate);registry.Drain([](u32){},[](u32){});
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
  assert(flat.find("\"word\":2153840640")!=std::string::npos);
  assert(flat.find("\"word\":2422276100")!=std::string::npos);
  registry.Retire(gate);registry.Drain([](u32){},[](u32){});
  // Actual production Gate execution: threshold, capacity before serialization,
  // owner/debug/step guards, compiled dispatch, reset during an active callback.
  Program executable;executable.Add(CachedInterpreter::Interpret<false>,load);executable.End();
  BrowserCompiler::Gate execution_gate;
  execution_gate.owner=&cached;execution_gate.entry=executable.bytes.data();execution_gate.end=execution_gate.entry+executable.size;
  auto& r=cached.m_browser_compiler;r.Add(execution_gate);active_cached=&cached;
  for(unsigned i=0;i<127;++i)CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
  assert(request_calls==0 && cached.fallback_executions==127);
  r.queued=16;
  CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
  assert(request_calls==0 && execution_gate.hits==127 && !execution_gate.retained);
  r.queued=0;
  CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
  assert(request_calls==1 && r.queued==1 && execution_gate.retained);
  assert(r.Install(&execution_gate,execution_gate.id,execution_gate.epoch,CompiledSpy));
  const auto gpr_before=fixture.state.gpr[2];
  CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
  assert(fixture.state.gpr[2]==gpr_before+1 && r.compiled_calls==1);
  for(unsigned boundary=0;boundary<3;++boundary) {
    cached.on_owner=boundary!=0;cached.debug=boundary==1;cached.m_system.cpu.stepping=boundary==2;
    CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
    assert(r.compiled_calls==1);
  }
  cached.on_owner=true;cached.debug=false;cached.m_system.cpu.stepping=false;
  invalidate_during_call=true;
  CachedInterpreter::RunBrowserCompilerGate(fixture.state,execution_gate);
  assert(r.active==0 && r.compiled==0 && !execution_gate.retained && clear_calls==1);
  r.Retire(execution_gate);cached.DrainBrowserCompiler();
  std::puts("Verified actual compiler descriptor and Gate execution: threshold/capacity, retained payloads, PC flags, checked/end whitelist, rejection, owner guards and active reset");
}
