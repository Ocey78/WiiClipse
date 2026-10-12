"""Extract production descriptor construction without adapting its body."""
from pathlib import Path
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
