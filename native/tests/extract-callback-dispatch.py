"""Extract real cached callback-loop bodies, including compact interpreter runs.

Usage: python3 extract-callback-dispatch.py DOLPHIN_SOURCE OUTPUT_DIRECTORY
"""
from pathlib import Path
import runpy
import sys
from source_extraction import without_browser_compiler

runpy.run_path(str(Path(__file__).with_name("extract-interpreter-dispatch.py")), run_name="__main__")
source = Path(sys.argv[1]) / "Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"
text = without_browser_compiler(source.read_text())
output = Path(sys.argv[2])


def definition(prefix):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]


parts = [definition("void CachedInterpreter::ExecuteOneBlock("),
         "template <bool profiled>\n" + definition("s32 CachedInterpreter::EndBlock("),
         definition("s32 CachedInterpreter::RunBrowserIntegerOps(PowerPC::PowerPCState&"),
         definition("s32 CachedInterpreter::RunBrowserInterpretOps(PowerPC::PowerPCState&")]
with (output / "callback-dispatch-loop.h").open("w", encoding="utf-8", newline="\n") as handle:
    handle.write("// Actual patched callback loop and callbacks.\n" + "\n\n".join(parts) + "\n")
print("Extracted actual ExecuteOneBlock, EndBlock, integer-run and interpreter-run callbacks")
