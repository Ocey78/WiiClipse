// Real native handlers and 64-bit CR representation are the reference. The
// independent lowering model uses the same scalar/Wasm-width operations as JS.
#define TEST_BROWSER_COMPILER_NATIVE_CR
#define main existing_dispatch_regression
#include "browser-direct-interpreter-dispatch.cpp"
#undef main
static unsigned cases=0;
static void CompareLowered(Fixture& fixture,UGeckoInstruction instruction,bool is_signed) {
  auto& state=fixture.state;const u32 lhs=state.gpr[instruction.RA];
  const u32 rhs=is_signed?u32(s32(instruction.SIMM_16)):instruction.UIMM;
  const bool lt=is_signed?s32(lhs)<s32(rhs):lhs<rhs;
  const bool gt=is_signed?s32(lhs)>s32(rhs):lhs>rhs;
  const u32 nibble=(lt?8u:gt?4u:2u)|((state.xer_so_ov>>1)?1u:0u);
  const u32 low=!(nibble&2),high=1u|(u32(!(nibble&4))<<31)|(u32(!!(nibble&8))<<30)|(u32(!!(nibble&1))<<27);
  state.cr.fields[instruction.CRFD]=(u64(high)<<32)|low;
}
static u32 ReadCR(const PowerPC::PowerPCState& state,u32 bi) {
  const u64 field=state.cr.fields[bi>>2];const u32 high=u32(field>>32),low=u32(field);
  switch(bi&3) {
  case 0:return (high>>30)&1;
  case 1:return s32(high)>0 || (high==0 && low!=0);
  case 2:return low==0;
  default:return (high>>27)&1;
  }
}
static void BranchLowered(Fixture& fixture,UGeckoInstruction instruction,bool conditional) {
  auto& state=fixture.state;bool taken=true;
  if(conditional) {
    if(!(instruction.BO&4))CTR(state)--;
    const bool counter=(instruction.BO&4) || (((CTR(state)!=0)^(instruction.BO>>1))&1);
    const bool condition=(instruction.BO&16) || (ReadCR(state,instruction.BI)==((instruction.BO>>3)&1));
    taken=counter&&condition;
  }
  if(taken) {
    if(instruction.LK)LR(state)=state.pc+4;
    const u32 displacement=conditional?u32(s32(s16(instruction.BD<<2))):u32(s32(u32(instruction.LI)<<8)>>6);
    state.npc=displacement+(instruction.AA?0:state.pc);
  }
  *fixture.interpreter.BrowserCompilerEndBlockFlag()=true;
}
static void CheckCompare(u32 word,const Fixture& seed,bool is_signed) {
  Fixture expected,actual;expected.state=actual.state=seed.state;
  const UGeckoInstruction instruction{word};
  (is_signed?Interpreter::cmpi:Interpreter::cmpli)(expected.interpreter,instruction);
  CompareLowered(actual,instruction,is_signed);
  assert(std::memcmp(&expected.state,&actual.state,sizeof(actual.state))==0);++cases;
}
static void CheckBranch(u32 word,const Fixture& seed,bool conditional) {
  Fixture expected,actual;expected.state=actual.state=seed.state;
  const UGeckoInstruction instruction{word};
  (conditional?Interpreter::bcx:Interpreter::bx)(expected.interpreter,instruction);
  BranchLowered(actual,instruction,conditional);
  if(std::memcmp(&expected.state,&actual.state,sizeof(actual.state))!=0)
    std::fprintf(stderr,"Original probe branch mismatch %08x: pc %08x/%08x npc %08x/%08x CTR %08x/%08x LR %08x/%08x\n",word,expected.state.pc,actual.state.pc,expected.state.npc,actual.state.npc,CTR(expected.state),CTR(actual.state),LR(expected.state),LR(actual.state));
  assert(std::memcmp(&expected.state,&actual.state,sizeof(actual.state))==0);
  assert(expected.interpreter.m_end_block==actual.interpreter.m_end_block && actual.interpreter.m_end_block);
  ++cases;
}
int main() {
  Fixture seed;seed.state.pc=0xfffffffcu;seed.state.npc=0x13579bdf;
  for(u32 field=0;field<8;++field)seed.state.cr.fields[field]=0x123456789abcdef0;
  for(bool is_signed:{false,true})for(u32 field=0;field<8;++field)for(u32 ra:{0u,1u,31u})for(u32 value:{0u,1u,0x7fffu,0x8000u,0x80000000u,0xffffffffu})for(u32 immediate:{0u,1u,0x7fffu,0x8000u,0xffffu})for(u8 xer:{u8(0),u8(1),u8(2),u8(3),u8(255)}) {
    seed.state.gpr[ra]=value;seed.state.xer_so_ov=xer;
    CheckCompare(((is_signed?11u:10u)<<26)|(field<<23)|(ra<<16)|immediate,seed,is_signed);
  }
  // Every condition bit, all branch options, decrement wrap and arbitrary native
  // CR encodings, including GT represented by positive high/low halves.
  for(u64 cr:{0ull,1ull,0x100000000ull,0x8000000000000000ull,0x4000000000000000ull,0x0800000000000000ull,0xffffffffffffffffull,0x123456789abcdef0ull})
    for(u32 ctr:{0u,1u,2u,0xffffffffu})for(u32 bo=0;bo<32;++bo)for(u32 bi=0;bi<32;++bi)for(u32 bits=0;bits<4;++bits) {
      seed.state.cr.fields[bi>>2]=cr;CTR(seed.state)=ctr;LR(seed.state)=0x55667788;
      CheckBranch((16u<<26)|(bo<<21)|(bi<<16)|0xfffc|bits,seed,true);
    }
  for(u32 pc:{0u,4u,0x7ffffffcu,0xfffffffcu})for(u32 displacement:{0u,4u,0x01fffffcu,0x02000000u,0x03fffffcu})for(u32 bits=0;bits<4;++bits) {
    seed.state.pc=pc;CheckBranch((18u<<26)|displacement|bits,seed,false);
  }
  for(u32 pc:{0u,4u,0x7ffffffcu,0xfffffffcu})for(u32 displacement:{0u,4u,0x7ffcu,0x8000u,0xfffcu})for(u32 bits=0;bits<4;++bits) {
    seed.state.pc=pc;CheckBranch((16u<<26)|(20u<<21)|displacement|bits,seed,true);
  }
  std::printf("Verified %u actual compare/branch paths, full CR encoding, XER byte, taken-only LR, CTR wrap, PC wrap and private end flag\n",cases);
}
