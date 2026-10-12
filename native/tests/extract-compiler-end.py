"""Extract actual terminal callback, monitor implementation and register layouts."""
from pathlib import Path
import re
import sys

source=Path(sys.argv[1])/"Source/Core"
pristine=(Path(sys.argv[3])/"Source/Core") if len(sys.argv)>3 else source
output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
def definition(text,prefix):
    start=text.index(prefix);opening=text.index("{",start);depth=1;end=opening+1
    while depth:
        depth+=(text[end]=="{")-(text[end]=="}");end+=1
    return text[start:end]
gekko=(source/"Core/PowerPC/Gekko.h").read_text()
registers=["SPR_MMCR0","SPR_MMCR1","SPR_PMC1","SPR_PMC2","SPR_PMC3","SPR_PMC4","EXCEPTION_PERFORMANCE_MONITOR"]
constants="\n".join("constexpr u32 "+name+"="+re.search(r"\b"+name+r"\s*=\s*(0x[0-9A-Fa-f]+|\d+)",gekko).group(1)+";" for name in registers)
bitfield=(pristine/"Common/BitField.h").read_text()
bitfield=bitfield[bitfield.index("#pragma pack(1)"):bitfield.index("#pragma pack()")+len("#pragma pack()")]
unions="\n".join(definition(gekko,"union "+name)+";" for name in ["UReg_MMCR0","UReg_MMCR1"])
powerpc=(pristine/"Core/PowerPC/PowerPC.h").read_text()
macros="\n".join(re.search(r"^#define "+name+r"\(ppc_state\).*",powerpc,re.M).group(0) for name in ["MMCR0","MMCR1"])
(output/"compiler-end-definitions.h").write_text(constants+"\n"+bitfield+"\n"+unions+"\n"+macros+"\n")
cpp=(source/"Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp").read_text()
header=(source/"Core/PowerPC/CachedInterpreter/CachedInterpreter.h").read_text()
monitor=definition((pristine/"Core/PowerPC/PowerPC.cpp").read_text(),"void UpdatePerformanceMonitor(")
operands=definition(header,"struct CachedInterpreter::EndBlockOperands<false>")
end=definition(cpp,"s32 CachedInterpreter::EndBlock(PowerPC::PowerPCState&")
(output/"compiler-end.h").write_text("namespace PowerPC {\n"+monitor+"\n}\n"+"template <>\n"+operands+";\n"+"template <bool profiled>\n"+end+"\n")
