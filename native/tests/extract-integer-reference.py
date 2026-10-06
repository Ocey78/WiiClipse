"""Extract the pinned interpreter's real code for differential CPU tests.

This deliberately uses the upstream instruction union, opcode tables, rotation
helper and integer handlers; it is not a second hand-written reference emulator.
Usage: python3 extract-integer-reference.py DOLPHIN_SOURCE OUTPUT_HEADER
"""
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]) / "Source/Core/Core/PowerPC"
out = pathlib.Path(sys.argv[2])
integer = (source / "Interpreter/Interpreter_Integer.cpp").read_text()
gekko = (source / "Gekko.h").read_text()
tables = (source / "Interpreter/Interpreter_Tables.cpp").read_text()
names = "addi addis mulli ori oris xori xoris rlwimix rlwinmx rlwnmx andx andcx eqvx nandx norx orx orcx slwx srwx xorx addx mullwx negx subfx cntlzwx extsbx extshx".split()


def definition(text, prefix, semicolon=False):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end + int(semicolon)]


parts = ["// Generated from the pinned Dolphin source; do not edit.\n"]
parts += [definition(gekko, "union UGeckoInstruction", True),
          definition(gekko, "inline u32 MakeRotationMask")]
parts += ["struct Interpreter { TestState& m_ppc_state;\n"
          "static void Helper_UpdateCR0(TestState&, u32) { std::abort(); }\n" +
          "\n".join(f"static void {name}(Interpreter&, UGeckoInstruction);" for name in names) + "\n};"]
parts += [definition(integer, "static bool HasAddOverflowed")]
parts += [definition(integer, f"void Interpreter::{name}(") for name in names]
parts += ["using ReferenceHandler = void (*)(Interpreter&, UGeckoInstruction);\n"
          "struct ReferenceEntry { u32 opcode; ReferenceHandler handler; const char* name; };\n"]
for table, out_name in [("s_primary_table", "primary"), ("s_table31", "table31")]:
    section = tables[tables.index(table):]
    section = section[:section.index("}};")]
    entries = re.findall(r"\{(\d+), Interpreter::(\w+)\}", section)
    selected = [(opcode, name) for opcode, name in entries if name in names]
    parts += [f"constexpr ReferenceEntry {out_name}[] = {{\n" +
              "\n".join(f'  {{{opcode}, Interpreter::{name}, "{name}"}},' for opcode, name in selected) + "\n};"]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n\n".join(parts) + "\n", newline="\n")
print(f"Extracted {len(names)} exact integer handlers and upstream opcode mappings")

# Exercise the actual run, append and flush methods with a minimal emitter/state
# fixture; this checks variable payload sizes and flush boundaries independently
# of the arithmetic oracle above.
cached = (source / "CachedInterpreter/CachedInterpreter.cpp").read_text()
emitter = (source / "CachedInterpreter/CachedInterpreterEmitter.cpp").read_text()
batch_parts = [definition(emitter, "void CachedInterpreterEmitter::Write(AnyCallback")]
for prefix in ["s32 CachedInterpreter::RunBrowserIntegerOps(PowerPC::PowerPCState&",
               "bool CachedInterpreter::AppendBrowserIntegerOp(",
               "void CachedInterpreter::FlushBrowserIntegerOps("]:
    batch_parts.append(definition(cached, prefix))
(out.parent / "integer-batch-reference.h").write_text("\n\n".join(batch_parts) + "\n", newline="\n")
