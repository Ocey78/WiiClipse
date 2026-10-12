"""Extract exact pinned handlers and patched callbacks for the dispatch regression.

Usage: python3 extract-interpreter-dispatch.py DOLPHIN_SOURCE OUTPUT_DIRECTORY
The C++ fixture replaces only heavyweight state, memory and debugger boundaries;
all instruction handlers, callback bodies and opcode mappings come from source.
"""
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]) / "Source/Core/Core/PowerPC"
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)


def definition(text, prefix, semicolon=False):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end + int(semicolon)]


def write(name, content):
    with (output / name).open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("// Extracted verbatim from the pinned source.\n" + content + "\n")


gekko = (source / "Gekko.h").read_text()
write("interpreter-dispatch-instruction.h", definition(gekko, "union UGeckoInstruction", True) + "\n" +
      definition(gekko, "constexpr s32 SignExt16(") + "\n" + definition(gekko, "constexpr s32 SignExt26("))

integer = (source / "Interpreter/Interpreter_Integer.cpp").read_text()
branch = (source / "Interpreter/Interpreter_Branch.cpp").read_text()
memory = (source / "Interpreter/Interpreter_LoadStore.cpp").read_text()
handlers = [definition(memory, "static u32 Helper_Get_EA("), definition(memory, "static u32 Helper_Get_EA_U(")]
handlers += ["template <typename T>\n" + definition(integer, "void Interpreter::Helper_IntCompare(")]
handlers += [definition(integer, f"void Interpreter::{name}(") for name in ["cmpi", "cmpli"]]
handlers += [definition(branch, f"void Interpreter::{name}(") for name in ["bx", "bcx"]]
handlers += [definition(memory, f"void Interpreter::{name}(") for name in ["lwz", "stw", "lwzu"]]
write("interpreter-dispatch-handlers.h", "\n\n".join(handlers))

tables = (source / "Interpreter/Interpreter_Tables.cpp").read_text()
section = tables[tables.index("s_primary_table"):]
section = section[:section.index("}};")]
entries = re.findall(r"\{(\d+), Interpreter::(\w+)\}", section)
names = {"cmpi", "cmpli", "bx", "bcx", "lwz", "stw", "lwzu"}
write("interpreter-dispatch-table.h", "constexpr ReferenceEntry primary[] = {\n" +
      "\n".join(f"  {{{opcode}, Interpreter::{name}}}," for opcode, name in entries if name in names) + "\n};")

cached = (source / "CachedInterpreter/CachedInterpreter.cpp").read_text()
write("interpreter-dispatch-helper.h", definition(cached, "static void DispatchBrowserInstruction("))
callbacks = ["template <bool write_pc>\n" + definition(cached, prefix) for prefix in [
    "s32 CachedInterpreter::Interpret(PowerPC::PowerPCState&",
    "s32 CachedInterpreter::InterpretAndCheckExceptions("]]
write("interpreter-dispatch-callbacks.h", "\n\n".join(callbacks))
print("Extracted real dispatch helper, both callback paths, seven handlers and pinned opcode mappings")
