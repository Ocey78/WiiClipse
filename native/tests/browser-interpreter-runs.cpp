// Production callbacks and DoJit are extracted by extract-interpreter-runs.py.
// Only memory, debugger/HLE and code-emitter boundaries are test doubles.
#include <array>
#include <cassert>
#include <bit>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include "Common/CommonTypes.h"
#include "runs-instruction.h"
#include "Core/PowerPC/CachedInterpreter/BrowserIntegerOps.h"
#include "Core/PowerPC/CachedInterpreter/BrowserInterpretOps.h"
constexpr u32 EXCEPTION_DSI = 8, EXCEPTION_PROGRAM = 128;
namespace PowerPC {
constexpr u32 CR_SO=1, CR_EQ=2, CR_GT=4, CR_LT=8;
enum class CoreMode { JIT };
struct PowerPCState {
  u32 gpr[32]{}, pc=0x80001000, npc=0x80001004, Exceptions=0;
  s32 downcount=100;
  struct { u32 fields[8]{}; void SetField(u32 i,u32 v) { fields[i]=v; } } cr;
  bool GetXER_SO() const { return true; }
};
struct PowerPCManager {
  unsigned checks=0;
  struct BreakPoints { u32 address=0; bool IsAddressBreakPoint(u32 pc) { return pc==address; } } breaks;
  void CheckExceptions() { ++checks; }
  auto& GetBreakPoints() { return breaks; }
};
}
struct Memory {
  PowerPC::PowerPCState& state;
  std::array<u8,256> bytes{};
  std::vector<std::array<u32,3>> accesses;
  template<class T> T Read(u32 address) {
    accesses.push_back({0,address,sizeof(T)});
    if(address>bytes.size()-sizeof(T)) { state.Exceptions|=EXCEPTION_DSI; return 0; }
    T value=0; for(size_t i=0;i<sizeof(T);++i) value=T((value<<8)|bytes[address+i]); return value;
  }
  template<class T> void Write(u32 value,u32 address) {
    accesses.push_back({1,address,value});
    if(address>bytes.size()-sizeof(T)) { state.Exceptions|=EXCEPTION_DSI; return; }
    for(size_t i=0;i<sizeof(T);++i) bytes[address+i]=u8(value>>((sizeof(T)-1-i)*8));
  }
};
struct Interpreter {
  using Instruction=void(*)(Interpreter&,UGeckoInstruction);
  PowerPC::PowerPCState& m_ppc_state; Memory& m_mmu;
  template<class T> static void Helper_IntCompare(PowerPC::PowerPCState&,UGeckoInstruction,T,T);
  #include "runs-handler-declarations.h"
  static void Other(Interpreter& i,UGeckoInstruction inst) { i.m_ppc_state.gpr[15]^=inst.hex; }
  static Instruction GetInterpreterOp(UGeckoInstruction inst) { switch(inst.OPCD) {
    #include "runs-table.h"
    default:return Other;
  } }
};
// Branches are excluded from runs; these only satisfy the existing dispatch helper.
void Interpreter::bx(Interpreter& i,UGeckoInstruction w) { Other(i,w); }
void Interpreter::bcx(Interpreter& i,UGeckoInstruction w) { Other(i,w); }
#include "runs-handlers.h"
#include "runs-dispatch.h"
struct Fixture {
  PowerPC::PowerPCState state{}; Memory memory{state}; Interpreter interpreter{state,memory};
  PowerPC::PowerPCManager manager;
};
struct CPU { bool stepping=false; bool IsStepping() const { return stepping; } };
struct System {
  Fixture& fixture; CPU cpu; int timing=0;
  auto& GetInterpreter(){return fixture.interpreter;} auto& GetPowerPC(){return fixture.manager;}
  auto& GetCPU(){return cpu;} auto& GetCoreTiming(){return timing;}
};
struct JitBlock { struct ProfileData {}; std::unique_ptr<ProfileData> profile_data; };
constexpr u32 FL_LOADSTORE=1, FL_USE_FPU=2;
namespace PPCAnalyst {
struct Info { u32 flags=0,num_cycles=1; };
struct CodeOp { u32 address; UGeckoInstruction inst; Info* opinfo; bool skip=false,canEndBlock=false,branchIsIdleLoop=false,fpException=false; };
}
namespace HLE {
enum class HookType { None, Start, Replace };
struct Result { HookType type; u32 hook_index=1; explicit operator bool() const {return type!=HookType::None;} };
Result TryReplaceFunction(const std::map<u32,HookType>& hooks,u32 pc,PowerPC::CoreMode) {
  const auto found=hooks.find(pc); return {found==hooks.end()?HookType::None:found->second};
}
}
struct CachedInterpreter {
  using AnyCallback=s32(*)(PowerPC::PowerPCState&,const void*);
  template<class T> using Callback=s32(*)(PowerPC::PowerPCState&,const T&);
  template<class T> static auto CallbackCast(Callback<T> cb){return cb;}
  template<class T> static AnyCallback AnyCallbackCast(Callback<T> cb){return reinterpret_cast<AnyCallback>(cb);}
  struct InterpretOperands { Interpreter& interpreter; Interpreter::Instruction func; u32 current_pc; UGeckoInstruction inst; };
  struct InterpretAndCheckExceptionsOperands:InterpretOperands { PowerPC::PowerPCManager& power_pc;u32 downcount; };
  struct CheckHaltOperands { PowerPC::PowerPCManager& power_pc;u32 pc,downcount; };
  struct CheckIdleOperands { int& timing;u32 pc; };
  struct HLEFunctionOperands { System& system;u32 pc,hook; };
  struct WriteBrokenBlockNPCOperands {u32 pc;};
  struct StartProfiledBlockOperands {JitBlock::ProfileData* profile;};
  template<bool profile> struct EndBlockOperands;
  template<bool pc> static s32 Interpret(PowerPC::PowerPCState&,const InterpretOperands&);
  template<bool pc> static s32 InterpretAndCheckExceptions(PowerPC::PowerPCState&,const InterpretAndCheckExceptionsOperands&);
  static s32 RunBrowserInterpretOps(PowerPC::PowerPCState&,const BrowserInterpret::Header&);
  static s32 RunBrowserInterpretOps(std::ostream&,const BrowserInterpret::Header&);
  static s32 RunBrowserIntegerOps(PowerPC::PowerPCState&,const BrowserInteger::Header&);
  static s32 CheckBreakpoint(PowerPC::PowerPCState&,const CheckHaltOperands&){return 1;}
  static s32 CheckFPU(PowerPC::PowerPCState&,const CheckHaltOperands&){return 2;}
  static s32 CheckIdle(PowerPC::PowerPCState&,const CheckIdleOperands&){return 3;}
  static s32 HLEFunction(PowerPC::PowerPCState&,const HLEFunctionOperands&){return 4;}
  static s32 WriteBrokenBlockNPC(PowerPC::PowerPCState& p,const WriteBrokenBlockNPCOperands& o){p.npc=o.pc;return 1;}
  static s32 StartProfiledBlock(PowerPC::PowerPCState&,const StartProfiledBlockOperands&){return 5;}
  template<bool p> static s32 EndBlock(PowerPC::PowerPCState& state,const EndBlockOperands<p>& o){state.downcount-=o.downcount;return 0;}
  bool AppendBrowserInterpretOp(Interpreter&,UGeckoInstruction,u32);
  bool AppendBrowserIntegerOp(u32,u32);
  void FlushBrowserInterpretOps(); void FlushBrowserIntegerOps(); void WriteEndBlock();
  bool HandleFunctionHooking(u32); bool DoJit(u32,JitBlock*,u32);
  BrowserInterpret::Batch m_browser_interpret_batch{}; BrowserInteger::Batch m_browser_integer_batch{};
  System m_system;
  std::map<u32,HLE::HookType> m_ppc_symbol_db;
  bool debug=false,profile=false;
  bool IsDebuggingEnabled()const{return debug;} bool IsProfilingEnabled()const{return profile;}
  bool HasWriteFailed()const{return false;}
  bool ShouldHandleFPExceptionForInstruction(const PPCAnalyst::CodeOp* op)const{return op->fpException;}
  // These tests exercise the general builder, outside 0022's exact five-op loop.
  bool WriteBrowserCacheFlushLoop(){return false;}
  struct {bool memcheck=false;} jo;
  struct {u32 blockStart=0,fifoBytesSinceCheck=0,downcountAmount=0,numLoadStoreInst=0,numFloatingPointInst=0,compilerPC=0,instructionsLeft=0;
    bool firstFPInstructionFound=false;JitBlock* curBlock=nullptr;PPCAnalyst::CodeOp* op=nullptr;struct{u32 numCycles=0;}st;} js;
  struct {u32 m_num_instructions=0;bool m_broken=false;} code_block;
  std::vector<PPCAnalyst::CodeOp> m_code_buffer;
  struct Record { AnyCallback callback;std::vector<u8> bytes; };
  std::vector<Record> records;
  explicit CachedInterpreter(Fixture& f):m_system{f}{}
  void Write(AnyCallback cb,const void* operands,size_t size){
    Record r{cb,std::vector<u8>(size)};std::memcpy(r.bytes.data(),operands,size);records.push_back(std::move(r));
  }
  template<class T> void Write(Callback<T> cb,const T& operands){Write(AnyCallbackCast(cb),&operands,sizeof(T));}
  std::vector<std::string> Labels()const;
};
template<> struct CachedInterpreter::EndBlockOperands<false>{u32 downcount,loads,fp;};
template<> struct CachedInterpreter::EndBlockOperands<true>:EndBlockOperands<false>{JitBlock::ProfileData* profile;};
#define WARN_LOG_FMT(...) ((void)0)
#include "runs-callbacks.h"
#include "runs-builder.h"
// Capture the actual disassembler's fields without depending on fmt's formatting.
namespace fmt {
template<class... T> void println(std::ostream& stream,const char*,T... values) {
  ((stream<<values<<' '),...);stream<<'\n';
}
}
#include "runs-disassembler.h"
std::vector<std::string> CachedInterpreter::Labels()const {
  std::vector<std::string> result;
  for(const auto& r:records) {
    const auto cb=r.callback;
    if(cb==AnyCallbackCast(RunBrowserInterpretOps)) result.push_back("run");
    else if(cb==AnyCallbackCast(RunBrowserIntegerOps)) result.push_back("integer");
    else if(cb==AnyCallbackCast(Interpret<false>)) result.push_back("ordinary");
    else if(cb==AnyCallbackCast(Interpret<true>)) result.push_back("pc");
    else if(cb==AnyCallbackCast(InterpretAndCheckExceptions<false>)||cb==AnyCallbackCast(InterpretAndCheckExceptions<true>)) result.push_back("checked");
    else if(cb==AnyCallbackCast(CheckBreakpoint)) result.push_back("breakpoint");
    else if(cb==AnyCallbackCast(CheckFPU)) result.push_back("fpu");
    else if(cb==AnyCallbackCast(CheckIdle)) result.push_back("idle");
    else if(cb==AnyCallbackCast(HLEFunction)) result.push_back("hle");
    else if(cb==AnyCallbackCast(WriteBrokenBlockNPC)) result.push_back("npc");
    else if(cb==AnyCallbackCast(StartProfiledBlock)) result.push_back("profile");
    else result.push_back("end");
  }
  return result;
}
static PPCAnalyst::Info basic{},memoryInfo{FL_LOADSTORE,2},fpInfo{FL_USE_FPU,3};
static PPCAnalyst::CodeOp Op(u32 primary,u32 pc=0){
  return {pc,UGeckoInstruction{(primary<<26)|(2u<<21)|(1u<<16)|4u},primary>=32&&primary<=45?&memoryInfo:&basic};
}
static void Build(CachedInterpreter& c,std::vector<PPCAnalyst::CodeOp> ops,bool broken=false){
  for(size_t i=0;i<ops.size();++i) if(!ops[i].address)ops[i].address=0x80004000+u32(i)*4;
  c.m_code_buffer=ops;c.code_block={u32(ops.size()),broken};JitBlock b;
  assert(c.DoJit(0x80004000,&b,0x80009000));
}
static void CheckLabels(CachedInterpreter& c,std::initializer_list<const char*> labels){
  const auto actual=c.Labels();std::vector<std::string> expected(labels.begin(),labels.end());
  if(actual!=expected){for(const auto& s:actual)std::fprintf(stderr,"%s ",s.c_str());std::fprintf(stderr,"\n");}
  assert(actual==expected);
}
int main(){
  // Removing a flush, batching an exceptional callback, or reversing the two
  // batch types changes these real DoJit emissions and downstream CPU state.
  {Fixture f;CachedInterpreter c(f);Build(c,{Op(10)});CheckLabels(c,{"ordinary"});}
  {Fixture f;CachedInterpreter c(f);Build(c,{Op(10),Op(11)});CheckLabels(c,{"run"});
    assert(c.records[0].bytes.size()<2*(sizeof(CachedInterpreter::AnyCallback)+sizeof(CachedInterpreter::InterpretOperands)));}
  {Fixture f;CachedInterpreter c(f);std::vector<PPCAnalyst::CodeOp> ops(33,Op(10));Build(c,ops);CheckLabels(c,{"run","ordinary"});}
  {Fixture f;CachedInterpreter c(f);Build(c,{Op(10),Op(11,0x80004010)});CheckLabels(c,{"ordinary","ordinary"});}
  {Fixture f;CachedInterpreter c(f);Build(c,{Op(10),Op(11),Op(14),Op(32),Op(36)});CheckLabels(c,{"run","integer","run"});}
  {Fixture f;CachedInterpreter c(f);c.jo.memcheck=true;Build(c,{Op(10),Op(11),Op(32),Op(10),Op(11)});CheckLabels(c,{"run","checked","run"});}
  {Fixture f;CachedInterpreter c(f);auto fp=Op(63);fp.opinfo=&fpInfo;fp.fpException=true;Build(c,{Op(10),Op(11),fp});CheckLabels(c,{"run","fpu","checked"});}
  for(bool debug:{false,true}){Fixture f;CachedInterpreter c(f);c.debug=debug;c.m_system.cpu.stepping=!debug;
    if(debug) f.manager.breaks.address=0x80004000;Build(c,{Op(10),Op(11)});
    if(debug)CheckLabels(c,{"breakpoint","ordinary","ordinary"});else CheckLabels(c,{"ordinary","ordinary"});}
  {Fixture f;CachedInterpreter c(f);auto branch=Op(18);branch.canEndBlock=true;branch.branchIsIdleLoop=true;
    Build(c,{Op(10),Op(11),branch});CheckLabels(c,{"run","pc","idle","end"});assert(c.js.downcountAmount==3);}
  {Fixture f;CachedInterpreter c(f);auto idle=Op(10);idle.branchIsIdleLoop=true;
    Build(c,{Op(10),Op(11),idle});CheckLabels(c,{"run","ordinary","idle"});}
  for(u32 primary:{0u,4u,7u,16u,18u,19u,31u,46u,47u,48u,63u}) {
    Fixture f;CachedInterpreter c(f);Build(c,{Op(10),Op(11),Op(primary)});
    if(primary==7)CheckLabels(c,{"run","integer"});else CheckLabels(c,{"run","ordinary"});
  }
  {Fixture f;CachedInterpreter c(f);Build(c,{Op(10),Op(11)},true);CheckLabels(c,{"run","npc","end"});}
  for(auto type:{HLE::HookType::Start,HLE::HookType::Replace}){Fixture f;CachedInterpreter c(f);
    c.m_ppc_symbol_db[0x80004008]=type;Build(c,{Op(10),Op(11),Op(10)});
    if(type==HLE::HookType::Start)CheckLabels(c,{"run","hle","ordinary"});else CheckLabels(c,{"run","hle","end"});}
  {Fixture f;CachedInterpreter c(f);auto skipped=Op(10);skipped.skip=true;Build(c,{Op(10),skipped,Op(11)});CheckLabels(c,{"ordinary","ordinary"});}
  unsigned cases=0;
  for(u32 primary:{10u,11u,32u,33u,34u,35u,36u,37u,38u,39u,40u,41u,42u,43u,44u,45u})
    for(u32 initialFlags:{0u,EXCEPTION_DSI,EXCEPTION_PROGRAM})
      for(u32 base:{0u,16u,0xfffffffcu}) {
        Fixture expected,actual;
        for(u32 i=0;i<32;++i) expected.state.gpr[i]=i*3+7;
        expected.state.gpr[1]=base;expected.state.Exceptions=initialFlags;actual.state=expected.state;
        for(u32 i=0;i<256;++i)expected.memory.bytes[i]=u8(i*17);actual.memory.bytes=expected.memory.bytes;
        CachedInterpreter c(actual);Build(c,{Op(primary),Op(11)});CheckLabels(c,{"run"});
        for(const auto& op:c.m_code_buffer) CachedInterpreter::Interpret<false>(expected.state,{expected.interpreter,Interpreter::GetInterpreterOp(op.inst),op.address,op.inst});
        const auto& payload=*reinterpret_cast<const BrowserInterpret::Header*>(c.records[0].bytes.data());
        const s32 distance=CachedInterpreter::RunBrowserInterpretOps(actual.state,payload);
        assert(distance==sizeof(CachedInterpreter::AnyCallback)+c.records[0].bytes.size());
        assert(std::memcmp(&actual.state,&expected.state,sizeof(actual.state))==0);
        assert(actual.memory.bytes==expected.memory.bytes);assert(actual.memory.accesses==expected.memory.accesses);++cases;
      }
  // Cached/custom handlers remain authoritative, including exception side effects.
  for(u32 base:{16u,128u,0xfffffffcu}) {
    Fixture expected,actual;expected.state.gpr[1]=base;actual.state=expected.state;
    for(u32 i=0;i<256;++i)expected.memory.bytes[i]=u8(i*17);actual.memory.bytes=expected.memory.bytes;
    CachedInterpreter c(actual);Build(c,{Op(10),Op(11),Op(14),Op(32),Op(36),Op(14),Op(10)});
    CheckLabels(c,{"run","integer","run","integer","ordinary"});
    for(const auto& op:c.m_code_buffer) CachedInterpreter::Interpret<false>(expected.state,
      {expected.interpreter,Interpreter::GetInterpreterOp(op.inst),op.address,op.inst});
    for(const auto& r:c.records) {
      s32 distance;
      if(r.callback==CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserInterpretOps))
        distance=CachedInterpreter::RunBrowserInterpretOps(actual.state,*reinterpret_cast<const BrowserInterpret::Header*>(r.bytes.data()));
      else if(r.callback==CachedInterpreter::AnyCallbackCast(CachedInterpreter::RunBrowserIntegerOps))
        distance=CachedInterpreter::RunBrowserIntegerOps(actual.state,*reinterpret_cast<const BrowserInteger::Header*>(r.bytes.data()));
      else distance=CachedInterpreter::Interpret<false>(actual.state,*reinterpret_cast<const CachedInterpreter::InterpretOperands*>(r.bytes.data()));
      assert(distance==sizeof(CachedInterpreter::AnyCallback)+r.bytes.size());
    }
    assert(std::memcmp(&actual.state,&expected.state,sizeof(actual.state))==0);
    assert(actual.memory.bytes==expected.memory.bytes);assert(actual.memory.accesses==expected.memory.accesses);++cases;
  }
  {Fixture f;BrowserInterpret::Batch batch{};batch.header={&f.interpreter,2,0xfffffffc};
    batch.ops[0]={Interpreter::Other,10u<<26};batch.ops[1]={Interpreter::Other,11u<<26};
    CachedInterpreter::RunBrowserInterpretOps(f.state,batch.header);assert(f.state.gpr[15]==((10u^11u)<<26));assert(f.state.pc==0x80001000);
    std::ostringstream stream;
    assert(CachedInterpreter::RunBrowserInterpretOps(stream,batch.header)==sizeof(CachedInterpreter::AnyCallback)+BrowserInterpret::PayloadSize(2));
    assert(stream.str()=="4294967292 671088640 \n0 738197504 \n");}
  std::printf("Verified %u production run CPU/memory cases and complete DoJit batch boundaries\n",cases);
}
