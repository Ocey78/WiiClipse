"""Extract production descriptor construction without adapting its body."""
from pathlib import Path
import re
import sys

text=(Path(sys.argv[1])/"Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp").read_text()
prefix="std::string CachedInterpreter::DescribeBrowserCompilerBlock("
start=text.index(prefix); opening=text.index("{",start); depth=1; end=opening+1
while depth:
    depth+=(text[end]=="{")-(text[end]=="}"); end+=1
output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
(output/"compiler-descriptor.h").write_text(text[start:end]+"\n")
prefix="s32 CachedInterpreter::RunBrowserCompilerGate(PowerPC::PowerPCState&"
start=text.index(prefix); opening=text.index("{",start); depth=1; end=opening+1
while depth:
    depth+=(text[end]=="{")-(text[end]=="}"); end+=1
(output/"compiler-execution.h").write_text(text[start:end]+"\n")
# Preserve the actual compiled-profile loop as well as the default-profile loop
# covered by extract-callback-dispatch.py. The split definition starts with an
# #endif belonging to ExecuteOneBlock's compile gate; remove only that marker.
prefix="void CachedInterpreter::ExecuteCallbackStream("
start=text.index(prefix); opening=text.index("{",start); depth=1; end=opening+1
while depth:
    depth+=(text[end]=="{")-(text[end]=="}"); end+=1
loop=text[start:end].replace("::ExecuteCallbackStream(","::ExecuteActualCallbackStream(",1)
loop=loop.replace("{\n#endif", "{", 1)
(output/"compiler-loop.h").write_text(loop+"\n")
gekko=(Path(sys.argv[1])/"Source/Core/Core/PowerPC/Gekko.h").read_text()
registers="\n".join("constexpr u32 "+name+"="+re.search(r"\b"+name+r"\s*=\s*(\d+)",gekko).group(1)+";" for name in ["SPR_MMCR0","SPR_MMCR1","SPR_LR","SPR_CTR"])
(output/"compiler-descriptor-registers.h").write_text(registers+"\n")
