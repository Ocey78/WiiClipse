"""Extract the actual CheckFPU callback and its operand/exception definition."""
from pathlib import Path
import re
import sys

source=Path(sys.argv[1])/"Source/Core/Core/PowerPC"
output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
def definition(text,prefix):
    start=text.index(prefix);opening=text.index("{",start);depth=1;end=opening+1
    while depth:
        depth+=(text[end]=="{")-(text[end]=="}");end+=1
    return text[start:end]
cpp=(source/"CachedInterpreter/CachedInterpreter.cpp").read_text()
header=(source/"CachedInterpreter/CachedInterpreter.h").read_text()
gekko=(source/"Gekko.h").read_text()
constant=re.search(r"EXCEPTION_FPU_UNAVAILABLE\s*=\s*(0x[0-9A-Fa-f]+)",gekko).group(1)
(output/"compiler-fpu.h").write_text("constexpr u32 EXCEPTION_FPU_UNAVAILABLE="+constant+";\n"+
  definition(header,"struct CachedInterpreter::CheckHaltOperands")+";\n"+
  definition(cpp,"s32 CachedInterpreter::CheckFPU(PowerPC::PowerPCState&")+"\n")
descriptor=definition(cpp,"std::string CachedInterpreter::DescribeBrowserCompilerBlock(")
assert 'AnyCallbackCast(CheckFPU)' in descriptor, "Compiler must explicitly admit actual CheckFPU callback"
assert '"fpu"' in descriptor, "Descriptor must distinguish the exact FPU callback role"
