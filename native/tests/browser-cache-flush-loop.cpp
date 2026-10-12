// Compile C++20 with Source/Core and extract-cache-flush-loop.py's output.
// Production handlers/callbacks are extracted verbatim; only cache/CPU/HLE boundaries are doubled.
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <vector>
#include "Common/CommonTypes.h"
#include "cache-flush-instruction.h"
constexpr u32 BO_DONT_DECREMENT_FLAG = 4;
namespace CPU { enum class State { Running, Stepping }; }
namespace PowerPC {
struct PowerPCState {
  u32 pc = 0, npc = 0, Exceptions = 0, feature_flags = 3;
  s32 downcount = 0;
  u32 gpr[32]{}, spr[1024]{};
  bool m_enable_dcache = false;
  struct { bool IR = true; } msr;
  struct { u32 GetBit(u32) const { return 0; } } cr;
};
std::vector<std::array<u32, 3>> monitors;
void UpdatePerformanceMonitor(u32 cycles, u32 loads, u32 fp, PowerPCState&) { monitors.push_back({cycles,loads,fp}); }
}
u32& CTR(PowerPC::PowerPCState& state) { return state.spr[9]; }
u32& LR(PowerPC::PowerPCState& state) { return state.spr[8]; }
struct JitBlock { struct ProfileData { static void EndProfiling(ProfileData*,u32) { assert(false); } }; };
struct Cache {
  std::vector<unsigned> destroyed;
  const auto& GetRangesToFree() const { return destroyed; }
};
struct CPUStub {
  CPU::State state = CPU::State::Running;
  const CPU::State* GetStatePtr() const { return &state; }
  bool IsStepping() const { return state == CPU::State::Stepping; }
};
struct Interpreter;
struct System {
  Interpreter* interpreter = nullptr;
  Cache* cache = nullptr;
  CPUStub cpu;
  unsigned stop_at = 0, invalidate_at = 0;
  std::vector<u32> addresses;
  CPUStub& GetCPU() { return cpu; }
  Interpreter& GetInterpreter() { return *interpreter; }
  System& GetJitInterface() { return *this; }
  void InvalidateICacheLine(u32 address) {
    addresses.push_back(address);
    if (stop_at && addresses.size() == stop_at) cpu.state = CPU::State::Stepping;
    if (invalidate_at && addresses.size() == invalidate_at) cache->destroyed.push_back(1);
  }
};
struct Memory {
  System& system;
  void FlushDCacheLine(u32 address) { system.InvalidateICacheLine(address); }
  void StoreDCacheLine(u32 address) { system.InvalidateICacheLine(address); }
};
struct BranchWatch {
  std::vector<std::array<u32, 3>> events;
  bool GetRecordingActive() const { return true; }
  void HitTrue(u32 pc,u32 target,UGeckoInstruction,bool) { events.push_back({1,pc,target}); }
  void HitFalse(u32 pc,u32 target,UGeckoInstruction,bool) { events.push_back({0,pc,target}); }
};
struct Interpreter {
  using Instruction = void(*)(Interpreter&,UGeckoInstruction);
  PowerPC::PowerPCState& m_ppc_state;
  System& m_system;
  Memory& m_mmu;
  BranchWatch& m_branch_watch;
  bool m_end_block = false;
  static void dcbf(Interpreter&,UGeckoInstruction);
  static void dcbst(Interpreter&,UGeckoInstruction);
  static void addi(Interpreter&,UGeckoInstruction);
  static void bcx(Interpreter&,UGeckoInstruction);
  static Instruction GetInterpreterOp(UGeckoInstruction inst) {
    if (inst.OPCD == 14) return addi;
    if (inst.OPCD == 16) return bcx;
    return inst.SUBOP10 == 86 ? dcbf : dcbst;
  }
};
#include "cache-flush-handlers.h"
void DispatchBrowserInstruction(Interpreter& interpreter,UGeckoInstruction inst,Interpreter::Instruction fn) { fn(interpreter,inst); }
namespace HLE {
bool active = false;
bool TryReplaceFunction(int,u32,int) { return active; }
}
namespace PowerPC { enum CoreMode { JIT }; }
constexpr u32 FL_LOADSTORE = 1, FL_USE_FPU = 2;
struct Info { u32 num_cycles = 1, flags = 0; };
struct CodeOp { UGeckoInstruction inst{}; u32 address = 0; bool skip = false,canEndBlock = false,branchIsIdleLoop = false; Info* opinfo = nullptr; };
struct Operands { Interpreter& interpreter; Interpreter::Instruction func; u32 current_pc; UGeckoInstruction inst; };
template<bool> struct EndOperands;
template<> struct EndOperands<false> { u32 downcount,num_load_stores,num_fp_inst,padding = 0; };
template<> struct EndOperands<true> : EndOperands<false> { JitBlock::ProfileData* profile_data; };
struct CachedInterpreter;
struct LoopOperands { CachedInterpreter& cached; std::array<Operands,3> ops; EndOperands<false> end; };
struct CachedInterpreter {
  using InterpretOperands = Operands;
  using BrowserCacheFlushLoopOperands = LoopOperands;
  template<bool p> using EndBlockOperands = EndOperands<p>;
  System& m_system; PowerPC::PowerPCState& m_ppc_state; Interpreter& interpreter;
  Cache m_block_cache;
  struct { u32 m_num_instructions = 3; bool m_broken = false; } code_block;
  std::array<CodeOp,3> m_code_buffer;
  struct { bool memcheck = false; } jo;
  int m_ppc_symbol_db = 0;
  bool debug = false,profile = false;
  unsigned emitted = 0;
  bool IsDebuggingEnabled() const { return debug; }
  bool IsProfilingEnabled() const { return profile; }
  using AnyCallback = s32(*)(PowerPC::PowerPCState&,const void*);
  template<class T> void Write(s32(*)(PowerPC::PowerPCState&,const T&),const T&) { ++emitted; }
  template<bool w> static s32 Interpret(PowerPC::PowerPCState&,const Operands&);
  template<bool w> static s32 Interpret(std::ostream& out,const Operands& operands) { out<<operands.current_pc<<'\n';return sizeof(AnyCallback)+sizeof(operands); }
  template<bool p> static s32 EndBlock(PowerPC::PowerPCState&,const EndOperands<p>&);
  static s32 RunBrowserCacheFlushLoop(PowerPC::PowerPCState&,const LoopOperands&);
  static s32 RunBrowserCacheFlushLoop(std::ostream&,const LoopOperands&);
  bool WriteBrowserCacheFlushLoop();
};
#define __EMSCRIPTEN__ 1
#include "cache-flush-callbacks.h"
struct Fixture {
  PowerPC::PowerPCState state;
  System system;
  Memory memory{system}; BranchWatch watch;
  Interpreter interpreter{state,system,memory,watch};
  CachedInterpreter cached{system,state,interpreter};
  std::array<Info,3> infos{{{5,FL_LOADSTORE},{1,0},{1,0}}};
  Fixture(bool flush) {
    system.interpreter = &interpreter;
    system.cache = &cached.m_block_cache;
    state.pc = 0x80001200; state.npc = state.pc;
    cached.m_code_buffer = {{{UGeckoInstruction{flush ? 0x7c0018acu : 0x7c00186cu},state.pc,false,false,false,&infos[0]},
      {UGeckoInstruction{0x38630020},state.pc+4,false,false,false,&infos[1]},
      {UGeckoInstruction{0x4200fff8},state.pc+8,false,true,false,&infos[2]}}};
  }
  LoopOperands OperandsForLoop() { return {cached,{{
    {interpreter,Interpreter::GetInterpreterOp(cached.m_code_buffer[0].inst),0x80001200,cached.m_code_buffer[0].inst},
    {interpreter,Interpreter::addi,0x80001204,cached.m_code_buffer[1].inst},
    {interpreter,Interpreter::bcx,0x80001208,cached.m_code_buffer[2].inst}}},{7,1,0}}; }
};
int main() {
  unsigned cases = 0;
  for (bool flush : {false,true})
    for (u32 ctr : {0u,1u,2u,3u,64u,65u,1000u})
      for (s32 downcount : {-1,0,1,6,7,8,20,1000})
        for (u32 address : {0u,0xfffffff0u,0x80001200u})
          for (unsigned stop : {0u,1u,2u})
            for (unsigned invalidation : {0u,1u,2u}) {
              Fixture original(flush),actual(flush);
              original.state.downcount = actual.state.downcount = downcount;
              CTR(original.state) = CTR(actual.state) = ctr;
              original.state.gpr[3] = actual.state.gpr[3] = address;
              original.system.stop_at = actual.system.stop_at = stop;
              original.system.invalidate_at = actual.system.invalidate_at = invalidation;
              const auto a=original.OperandsForLoop(),b=actual.OperandsForLoop();
              PowerPC::monitors.clear();
              unsigned loops=0;
              do {
                CachedInterpreter::Interpret<false>(original.state,a.ops[0]);
                CachedInterpreter::Interpret<false>(original.state,a.ops[1]);
                CachedInterpreter::Interpret<true>(original.state,a.ops[2]);
                CachedInterpreter::EndBlock<false>(original.state,a.end);
              } while (++loops<64 && original.state.pc==a.ops[0].current_pc && original.state.downcount>0 &&
                       original.system.cpu.state==CPU::State::Running && original.cached.m_block_cache.destroyed.empty());
              const auto monitors=PowerPC::monitors;
              PowerPC::monitors.clear();
              assert(CachedInterpreter::RunBrowserCacheFlushLoop(actual.state,b)==0);
              assert(std::memcmp(&original.state,&actual.state,sizeof(actual.state))==0);
              assert(original.system.addresses==actual.system.addresses);
              assert(original.watch.events==actual.watch.events);
              assert(monitors==PowerPC::monitors);
              ++cases;
            }
  Fixture valid(true);
  assert(valid.cached.WriteBrowserCacheFlushLoop());
  std::ostringstream disassembly;
  const auto payload=valid.OperandsForLoop();
  const auto distance=CachedInterpreter::RunBrowserCacheFlushLoop(disassembly,payload);
  assert(distance==sizeof(CachedInterpreter::AnyCallback)+sizeof(payload));
  assert(disassembly.str().find("bounded to 64 iterations")!=std::string::npos);
  assert(disassembly.str().find(std::to_string(payload.ops[2].current_pc))!=std::string::npos);
  for(unsigned reject=0;reject<14;++reject) {
    Fixture f(true);
    switch(reject) {
      case 0:f.cached.debug=true;break; case 1:f.cached.profile=true;break;
      case 2:f.system.cpu.state=CPU::State::Stepping;break; case 3:f.cached.jo.memcheck=true;break;
      case 4:f.state.m_enable_dcache=true;break; case 5:f.cached.code_block.m_num_instructions=2;break;
      case 6:f.cached.code_block.m_broken=true;break; case 7:f.cached.m_code_buffer[1].inst.hex=0x38630021;break;
      case 8:f.cached.m_code_buffer[1].address+=4;break; case 9:HLE::active=true;break;
      case 10:f.cached.m_code_buffer[0].inst.hex=0x7c001bac;break; // dcbi is privileged, outside scope.
      case 11:f.cached.m_code_buffer[1].skip=true;break;
      case 12:f.cached.m_code_buffer[2].branchIsIdleLoop=true;break;
      case 13:f.cached.m_code_buffer[2].canEndBlock=false;break;
    }
    assert(!f.cached.WriteBrowserCacheFlushLoop());
    assert(f.cached.emitted==0);
    HLE::active=false;
  }
  std::printf("Verified %u real cache-loop native/batched paths, wrap, CTR0, timing, CPU stops, SMC exits, branch-watch and monitors; rejection gates pass\n",cases);
}
