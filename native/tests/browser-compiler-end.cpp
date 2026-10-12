// Monitor selections, interrupt controls, EndBlock and operand layout are all
// extracted from the actual source. Only the emulator state boundary is small.
#include <array>
#include <bit>
#include <cassert>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <type_traits>
#include "Common/CommonTypes.h"
#include "Common/Inline.h"
#include "compiler-end-definitions.h"
namespace PowerPC {
struct PowerPCState {
  u32 pc=0,npc=0,Exceptions=0;
  s32 downcount=0;
  std::array<u32,1024> spr{};
  std::array<u32,8> sentinels{};
  friend bool operator==(const PowerPCState&,const PowerPCState&)=default;
};
}
struct JitBlock { struct ProfileData { static void EndProfiling(ProfileData*,u32) { std::abort(); } }; };
struct CachedInterpreter {
  using AnyCallback=s32(*)(PowerPC::PowerPCState&,const void*);
  template<bool> struct EndBlockOperands;
  template<bool profiled> static s32 EndBlock(PowerPC::PowerPCState&,const EndBlockOperands<profiled>&);
};
#include "compiler-end.h"
static unsigned native_fallbacks=0,fast_ends=0;
static s32 GeneratedEnd(PowerPC::PowerPCState& state,const CachedInterpreter::EndBlockOperands<false>& operands) {
  // Mirrors the bounded generated Wasm guard. Its fallback is the actual native
  // terminal, including every monitor selector and high-bit interrupt control.
  if(state.spr[SPR_MMCR0] || state.spr[SPR_MMCR1]) {
    ++native_fallbacks;return CachedInterpreter::EndBlock<false>(state,operands);
  }
  ++fast_ends;state.pc=state.npc;
  state.downcount=std::bit_cast<s32>(u32(state.downcount)-operands.downcount);
  return 0;
}
int main() {
  unsigned cases=0;
  const std::array<s32,7> downcounts={std::numeric_limits<s32>::min(),-1,0,1,17,100,std::numeric_limits<s32>::max()};
  const std::array<u32,5> costs={0,1,17,0x80000000u,0xffffffffu};
  const std::array<u32,5> counters={0,1,0x7fffffffu,0x80000000u,0xffffffffu};
  std::array<std::array<u32,2>,67> controls{};
  for(unsigned bit=0;bit<32;++bit) { controls[1+bit]={1u<<bit,0};controls[33+bit]={0,1u<<bit}; }
  controls[65]={0xffffffffu,0xffffffffu};controls[66]={1u|(11u<<6)|(1u<<14)|(1u<<15),(11u<<27)|(1u<<22)};
  for(const auto& control:controls)for(s32 downcount:downcounts)for(u32 cost:costs)for(u32 counter:counters)for(u32 prior:{0u,8u,EXCEPTION_PERFORMANCE_MONITOR,0xffffffffu}) {
    PowerPC::PowerPCState original{};
    original.pc=0x12345678;original.npc=(cost&1)?0xfffffffcu:0x87654320;
    original.downcount=downcount;original.Exceptions=prior;
    original.spr.fill(0x13579bdf);original.sentinels.fill(0x2468ace0);
    original.spr[SPR_MMCR0]=control[0];original.spr[SPR_MMCR1]=control[1];
    for(u32 index:{SPR_PMC1,SPR_PMC2,SPR_PMC3,SPR_PMC4})original.spr[index]=counter;
    auto generated=original;
    const CachedInterpreter::EndBlockOperands<false> operands{cost,3,5};
    const auto fast_before=fast_ends,fallback_before=native_fallbacks;
    assert(CachedInterpreter::EndBlock<false>(original,operands)==0);
    assert(GeneratedEnd(generated,operands)==0 && generated==original);
    assert(original.pc==original.npc && u32(original.downcount)==u32(downcount)-cost);
    if(control[0]==0 && control[1]==0) {
      assert(fast_ends==fast_before+1 && native_fallbacks==fallback_before);
      assert(original.Exceptions==prior);
      for(u32 index:{SPR_PMC1,SPR_PMC2,SPR_PMC3,SPR_PMC4})assert(original.spr[index]==counter);
    } else assert(native_fallbacks==fallback_before+1 && fast_ends==fast_before);
    ++cases;
  }
  // Explicit interrupt and counting evidence, rather than equality alone.
  PowerPC::PowerPCState counting{};counting.spr[SPR_MMCR0]=1u|(11u<<6)|(1u<<14);
  counting.spr[SPR_MMCR1]=(11u<<27)|(1u<<22);counting.spr[SPR_PMC2]=0x7ffffffe;
  const CachedInterpreter::EndBlockOperands<false> operands{7,3,5};
  GeneratedEnd(counting,operands);
  assert(counting.spr[SPR_PMC1]==0 && counting.spr[SPR_PMC2]==0x80000005u);
  assert(counting.spr[SPR_PMC3]==5 && counting.spr[SPR_PMC4]==7);
  assert(counting.Exceptions==EXCEPTION_PERFORMANCE_MONITOR);
  std::printf("Verified %u actual terminal/monitor differential paths, all MMCR bits, PMC high bits, exceptions and signed wrap\n",cases);
}
