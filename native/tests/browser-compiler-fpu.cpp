// Actual CheckFPU callback, operand structure and exception flag extracted from source.
#include <array>
#include <cassert>
#include <cstdio>
#include "Common/CommonTypes.h"
namespace PowerPC {
struct PowerPCState { u32 pc=0,npc=0,Exceptions=0; s32 downcount=0; struct { bool FP=true; } msr; };
struct PowerPCManager {
  PowerPCState& state;unsigned checks=0;std::array<u32,3> seen{};
  void CheckExceptions() { ++checks;seen={state.pc,u32(state.downcount),state.Exceptions};state.pc=0xabcdef00; }
};
}
struct CachedInterpreter {
  using AnyCallback=s32(*)(PowerPC::PowerPCState&,const void*);
  struct CheckHaltOperands;
  static s32 CheckFPU(PowerPC::PowerPCState&,const CheckHaltOperands&);
};
#include "compiler-fpu.h"
int main()
{
  unsigned cases=0;
  for(bool fp:{false,true})
    for(u32 pc:{0u,0xfffffffcu,0x80001234u})
      for(s32 downcount:{-1,0,1,100})
        for(u32 consumed:{0u,1u,17u})
          for(u32 prior:{0u,8u,0x80u}) {
            PowerPC::PowerPCState state{0x11223344,0x55667788,prior,downcount,{fp}};
            PowerPC::PowerPCManager manager{state};
            const CachedInterpreter::CheckHaltOperands operands{manager,pc,consumed};
            const auto distance=CachedInterpreter::CheckFPU(state,operands);
            unsigned fp_operations=0;
            if(distance)++fp_operations; // Same zero-exit rule used by generated Wasm.
            if(fp) {
              assert(distance==sizeof(CachedInterpreter::AnyCallback)+sizeof(operands));
              assert(state.pc==0x11223344 && state.npc==0x55667788 && state.downcount==downcount);
              assert(state.Exceptions==prior && manager.checks==0 && fp_operations==1);
            } else {
              assert(distance==0 && fp_operations==0 && manager.checks==1);
              assert(manager.seen[0]==pc && manager.seen[1]==u32(downcount)-consumed);
              assert(manager.seen[2]==(prior|EXCEPTION_FPU_UNAVAILABLE));
              assert(state.pc==0xabcdef00 && state.npc==0x55667788);
            }
            ++cases;
          }
  std::printf("Verified %u actual FPU observer paths, unchanged enabled state, unavailable exception ordering/downcount/zero exit and original flags\n",cases);
}
