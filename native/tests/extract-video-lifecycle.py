"""Extract real browser video initialization and unload code for lifecycle tests.

Usage: python3 extract-video-lifecycle.py DOLPHIN_SOURCE OUTPUT_HEADER
"""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / "Source/Core"
out = Path(sys.argv[2])


def definition(text, prefix):
    start = text.index(prefix)
    opening = text.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]


core = (source / "Core/Core.cpp").read_text()
boot = (source / "DolphinLibretro/Boot.cpp").read_text()
initializer = definition(core, "const auto init_video = [&]")
unload = definition(boot, "void retro_unload_game(void)")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("// Extracted from the patched pinned Dolphin source.\n"
               "bool InitializeVideo(Core::System& system, const WindowSystemInfo& wsi)\n{\n" +
               initializer + ";\nreturn init_video();\n}\n\n" + unload + "\n", newline="\n")
print("Extracted actual video initializer and retro_unload_game")
