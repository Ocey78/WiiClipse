"""Extract actual MMU fast/slow methods for differential browser RAM tests.

Usage: python3 extract-ram-fastpath.py DOLPHIN_SOURCE OUTPUT_DIRECTORY
Only the slow method names are adapted for test entry counters. The source
bodies, byte swaps, BAT translation, RAM routes and wrapper methods stay exact.
"""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / "Source/Core/Core/PowerPC"
output = Path(sys.argv[2]); output.mkdir(parents=True, exist_ok=True)
cpp = (source / "MMU.cpp").read_text()
header = (source / "MMU.h").read_text()


def definition(text, prefix, semicolon=False):
    start = text.index(prefix); opening = text.index("{", start); end = opening + 1; depth = 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}"); end += 1
    return text[start:end + int(semicolon)]


def write(name, parts):
    with (output / name).open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("// Extracted source bodies; do not edit.\n" + "\n\n".join(parts) + "\n")


write("ram-fastpath-flags.h", [definition(header, "enum class XCheckTLBFlag", True)])
start = header.index("constexpr int BAT_INDEX_SHIFT")
end = header.index("constexpr size_t HW_PAGE_MASK", start)
end = header.index(";", end) + 1
write("ram-fastpath-constants.h", [header[start:end]])
write("ram-fastpath-helpers.h", [definition(cpp, f"static {ty} bswap({ty} val)") for ty in ["u8", "u16", "u32", "u64"]] + [
    definition(cpp, "static constexpr bool IsOpcodeFlag("), definition(cpp, "static bool TranslateBatAddress(")])
write("ram-fastpath-methods.h", [
    "template <std::unsigned_integral T>\n" + definition(cpp, "u8* MMU::GetBrowserRAMPointer("),
    "template <XCheckTLBFlag flag, std::unsigned_integral T, bool never_translate>\n" +
      definition(cpp, "T MMU::ReadFromHardware(").replace("T MMU::ReadFromHardware(", "T MMU::ReadFromHardwareBody(", 1),
    "template <XCheckTLBFlag flag, bool never_translate>\n" +
      definition(cpp, "void MMU::WriteToHardware(").replace("void MMU::WriteToHardware(", "void MMU::WriteToHardwareBody(", 1),
    "template <std::unsigned_integral T>\n" + definition(cpp, "T MMU::Read(const u32 address)"),
    "template <std::unsigned_integral T>\n" + definition(cpp, "void MMU::Write(const Common::MakeAtLeastU32<T> var, const u32 address)"),
    "template <>\n" + definition(cpp, "void MMU::Write<u64>(const u64 var, const u32 address)")])
print("Extracted original hardware routes, BAT translation, byte swaps and RAM fast path")
