"""Extract exact CR table and opt-in accessor, verify watch invalidation boundary."""
from pathlib import Path
import sys
source=Path(sys.argv[1])/"Source/Core"
pristine=(Path(sys.argv[3])/"Source/Core") if len(sys.argv)>3 else source
output=Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=True)
text=(source/"Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp").read_text()
assert all('"'+name+'"' in text for name in ["cmpi","cmpli","bx","bcx"]), "Native descriptor must explicitly lower the canonical four instructions"
header=(source/"Core/PowerPC/Interpreter/Interpreter.h").read_text()
start=header.index("bool* BrowserCompilerEndBlockFlag(");opening=header.index("{",start);end=header.index("}",opening)+1
accessor=header[start:end]
assert "return &m_end_block;" in accessor, "Use the real private flag address, never a guessed offset"
table=(source/"Core/PowerPC/ConditionRegister.cpp").read_text()
table_start=table.index("const std::array<u64, 16> ConditionRegister::s_crTable")
table_end=table.index(";",table_start)+1
watch=(pristine/"Core/Debugger/BranchWatch.h").read_text()
start=watch.index("void SetRecordingActive(");end=watch.index("\n  }",start)
assert "ClearCache(guard)" in watch[start:end], "Recording changes must invalidate compiled branch descriptors"
start=text.index("void CachedInterpreter::ClearCache(");end=text.index("\n}",start)
clear=text[start:end]
assert clear.index("m_browser_compiler.Reset()")<clear.index("m_block_cache.Clear()"), "Invalidate async compiler identities before code address reuse"
(output/"compiler-cr-table.h").write_text("namespace PowerPC {\n"+table[table_start:table_end]+"\n}\n")
(output/"compiler-branch-accessor.h").write_text(accessor+"\n")
