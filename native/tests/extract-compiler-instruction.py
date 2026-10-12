"""Extract the actual scalar instruction bridge for native pointer-width testing."""
from pathlib import Path
import sys

text=(Path(sys.argv[1])/"Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp").read_text()
prefix='extern "C" EMSCRIPTEN_KEEPALIVE void dweb_browser_compiler_instruction('
start=text.index(prefix);opening=text.index("{",start);depth=1;end=opening+1
while depth:
    depth+=(text[end]=="{")-(text[end]=="}");end+=1
bridge=text[start:end]
assert "DispatchBrowserInstruction(" in bridge, "Scalar bridge must preserve the proven direct-dispatch optimization"
# Native test executables carry 64-bit addresses. Adapt only scalar pointer
# carriers, never the instruction word or the by-value C++ aggregate body.
bridge=bridge.replace('extern "C" EMSCRIPTEN_KEEPALIVE ', '')
bridge=bridge.replace("u32 address", "uintptr_t address").replace("u32 handler", "uintptr_t handler")
output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
(output/"compiler-instruction.h").write_text(bridge+"\n")
