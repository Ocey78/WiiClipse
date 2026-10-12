// Real bridge and existing direct-dispatch helper, with only scalar pointer
// widths adapted for native64. Actual wasm32 ABI is covered by browser smoke.
#define main existing_dispatch_regression
#include "browser-direct-interpreter-dispatch.cpp"
#undef main
#include "compiler-instruction.h"
static void MutatingFallback(Interpreter& interpreter,UGeckoInstruction instruction) {
  interpreter.m_ppc_state.gpr[11]=instruction.hex;
  instruction.hex=0xabcdef01;
  interpreter.m_ppc_state.gpr[12]=instruction.hex;
}
static unsigned cases=0;
static void CompareBridge(u32 word,Interpreter::Instruction handler,const Fixture& seed) {
  Fixture expected,actual;
  expected.state=actual.state=seed.state;
  expected.memory.bytes=actual.memory.bytes=seed.memory.bytes;
  expected.watch.enabled=actual.watch.enabled=seed.watch.enabled;
  handler(expected.interpreter,UGeckoInstruction{word});
  dweb_browser_compiler_instruction(reinterpret_cast<uintptr_t>(&actual.interpreter),word,reinterpret_cast<uintptr_t>(handler));
  assert(std::memcmp(&expected.state,&actual.state,sizeof(actual.state))==0);
  assert(expected.memory.bytes==actual.memory.bytes && expected.memory.accesses==actual.memory.accesses);
  assert(expected.watch.hits==actual.watch.hits && expected.interpreter.m_end_block==actual.interpreter.m_end_block);
  ++cases;
}
int main() {
  Fixture seed;seed.state.pc=0xfffffffcu;seed.state.npc=0;
  for(u32 i=0;i<32;++i)seed.state.gpr[i]=i*4;
  for(u32 i=0;i<seed.memory.bytes.size();++i)seed.memory.bytes[i]=u8(i);
  for(u32 flags:{0u,EXCEPTION_DSI,EXCEPTION_PROGRAM})for(bool so:{false,true})for(bool watch:{false,true}) {
    seed.state.Exceptions=flags;seed.state.xer_so=so;seed.watch.enabled=watch;
    for(const auto& entry:primary)for(u32 reg:{0u,1u,31u})for(u32 immediate:{0u,1u,0x7fffu,0x8000u,0xffffu})
      CompareBridge((entry.opcode<<26)|(reg<<21)|(reg<<16)|immediate,entry.handler,seed);
    for(u32 opcode:{0u,10u,11u,16u,18u,32u,36u,63u}) {
      CompareBridge(opcode<<26,CustomFallback,seed);
      CompareBridge(opcode<<26,MutatingFallback,seed);
    }
    // Matching primary bits cannot override an authoritative different handler.
    CompareBridge(32u<<26,Interpreter::stw,seed);
    CompareBridge(36u<<26,Interpreter::lwz,seed);
  }
  seed.state.Exceptions=0;
  for(u32 ctr:{0u,1u,2u,0xffffffffu})for(u32 bo=0;bo<32;++bo)for(u32 bi=0;bi<32;++bi)for(u32 cr:{0u,15u})for(u32 low=0;low<4;++low) {
    CTR(seed.state)=ctr;for(auto& field:seed.state.cr.fields)field=cr;
    CompareBridge((16u<<26)|(bo<<21)|(bi<<16)|0xfffc|low,Interpreter::bcx,seed);
  }
  seed.state.gpr[1]=0xfffffffcu;
  for(u32 opcode:{32u,36u})CompareBridge((opcode<<26)|(2u<<21)|(1u<<16),opcode==32?Interpreter::lwz:Interpreter::stw,seed);
  CompareBridge((33u<<26)|(1u<<21)|(1u<<16)|4u,Interpreter::lwzu,seed);
  std::printf("Verified %u actual scalar-bridge/direct-dispatch cases, injected/mismatched handlers, by-value mutation, memory faults and branch watch\n",cases);
}
