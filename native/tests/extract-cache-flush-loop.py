"""Extract actual cache-maintenance handlers, callbacks and batch eligibility."""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / "Source/Core/Core/PowerPC"
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)

def definition(text, prefix):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth, end = 1, opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]

cached = (source / "CachedInterpreter/CachedInterpreter.cpp").read_text()
disassembler = (source / "CachedInterpreter/CachedInterpreter_Disassembler.cpp").read_text()
assert "LOOKUP_KV(CachedInterpreter::RunBrowserCacheFlushLoop)," in disassembler
parts = [definition(cached, "s32 CachedInterpreter::RunBrowserCacheFlushLoop(PowerPC::PowerPCState&"),
         definition(cached, "s32 CachedInterpreter::RunBrowserCacheFlushLoop(std::ostream&"),
         definition(cached, "bool CachedInterpreter::WriteBrowserCacheFlushLoop("),
         "template <bool profiled>\n" + definition(cached, "s32 CachedInterpreter::EndBlock("),
         "template <bool write_pc>\n" + definition(cached, "s32 CachedInterpreter::Interpret(PowerPC::PowerPCState&")]
(output / "cache-flush-callbacks.h").write_text("\n\n".join(parts) + "\n")
memory = (source / "Interpreter/Interpreter_LoadStore.cpp").read_text()
integer = (source / "Interpreter/Interpreter_Integer.cpp").read_text()
branch = (source / "Interpreter/Interpreter_Branch.cpp").read_text()
parts = [definition(memory, "static u32 Helper_Get_EA_X("),
         definition(memory, "void Interpreter::dcbf("), definition(memory, "void Interpreter::dcbst("),
         definition(integer, "void Interpreter::addi("), definition(branch, "void Interpreter::bcx(")]
(output / "cache-flush-handlers.h").write_text("\n\n".join(parts) + "\n")
gekko = (source / "Gekko.h").read_text()
(output / "cache-flush-instruction.h").write_text(definition(gekko, "union UGeckoInstruction") + ";\n" + definition(gekko, "constexpr s32 SignExt16("))
print("Extracted actual cache-flush callback, eligibility, four handlers and accounting")
