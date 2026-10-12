"""Extract actual MMU read/write methods and watchpoint behavior.

Usage: python3 extract-memcheck-guard.py DOLPHIN_SOURCE OUTPUT_DIRECTORY
Only the Memcheck function name is adapted to permit a test entry counter;
the body and Read/Write methods are copied verbatim.
"""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / "Source/Core/Core/PowerPC"
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
text = (source / "MMU.cpp").read_text()


def definition(prefix):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]


parts = [definition("void MMU::Memcheck(").replace("void MMU::Memcheck(", "void MMU::MemcheckBody(", 1),
         "template <std::unsigned_integral T>\n" + definition("T MMU::Read(const u32 address)"),
         "template <std::unsigned_integral T>\n" + definition("void MMU::Write(const Common::MakeAtLeastU32<T> var, const u32 address)"),
         "template <>\n" + definition("void MMU::Write<u64>(const u64 var, const u32 address)")]
with (output / "memcheck-guard-methods.h").open("w", encoding="utf-8", newline="\n") as handle:
    handle.write("// Actual source methods; test adapts only Memcheck's name.\n" + "\n\n".join(parts) + "\n")
print("Extracted actual MMU Read, Write, split 64-bit Write and Memcheck body")
