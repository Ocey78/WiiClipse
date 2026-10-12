"""Extract production callbacks/builders and pinned instruction handlers for run tests."""
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]) / 'Source/Core/Core/PowerPC'
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)

def definition(text, prefix, semicolon=False):
    start = text.index(prefix)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end + int(semicolon)]

def write(name, content):
    (output / name).write_text('// Extracted from production source.\n' + content + '\n', encoding='utf-8')

cached = (source / 'CachedInterpreter/CachedInterpreter.cpp').read_text()
assert 's32 CachedInterpreter::RunBrowserInterpretOps(' in cached, 'Production interpreter runs are missing'
gekko = (source / 'Gekko.h').read_text()
write('runs-instruction.h', definition(gekko, 'union UGeckoInstruction', True) + '\n' +
      definition(gekko, 'constexpr s32 SignExt16('))
integer = (source / 'Interpreter/Interpreter_Integer.cpp').read_text()
memory = (source / 'Interpreter/Interpreter_LoadStore.cpp').read_text()
names = ['lwz', 'lwzu', 'lbz', 'lbzu', 'stw', 'stwu', 'stb', 'stbu', 'lhz', 'lhzu', 'lha', 'lhau', 'sth', 'sthu']
write('runs-handler-declarations.h', '\n'.join(f'static void {name}(Interpreter&, UGeckoInstruction);' for name in ['cmpi', 'cmpli', 'addi', 'bx', 'bcx', *names]))
handlers = [definition(memory, 'static u32 Helper_Get_EA('), definition(memory, 'static u32 Helper_Get_EA_U('),
            'template <typename T>\n' + definition(integer, 'void Interpreter::Helper_IntCompare(')]
handlers += [definition(integer, f'void Interpreter::{name}(') for name in ['cmpi', 'cmpli', 'addi']]
handlers += [definition(memory, f'void Interpreter::{name}(') for name in names]
write('runs-handlers.h', '\n\n'.join(handlers))
table = (source / 'Interpreter/Interpreter_Tables.cpp').read_text()
table = table[table.index('s_primary_table'):]
table = table[:table.index('}};')]
entries = re.findall(r'\{(\d+), Interpreter::(\w+)\}', table)
write('runs-table.h', '\n'.join(f'case {opcode}: return {name};' for opcode, name in entries if name in ['cmpi', 'cmpli', 'addi', *names]))
write('runs-dispatch.h', definition(cached, 'static void DispatchBrowserInstruction('))
methods = ['s32 CachedInterpreter::RunBrowserInterpretOps(PowerPC::PowerPCState&',
           'bool CachedInterpreter::AppendBrowserInterpretOp(', 'void CachedInterpreter::FlushBrowserInterpretOps()',
           's32 CachedInterpreter::RunBrowserIntegerOps(PowerPC::PowerPCState&',
           'bool CachedInterpreter::AppendBrowserIntegerOp(', 'void CachedInterpreter::FlushBrowserIntegerOps()',
           'bool CachedInterpreter::HandleFunctionHooking(', 'void CachedInterpreter::WriteEndBlock()',
           'bool CachedInterpreter::DoJit(']
write('runs-builder.h', '\n\n'.join(definition(cached, prefix) for prefix in methods))
callbacks = ['template <bool write_pc>\n' + definition(cached, prefix) for prefix in [
    's32 CachedInterpreter::Interpret(PowerPC::PowerPCState&', 's32 CachedInterpreter::InterpretAndCheckExceptions(']]
write('runs-callbacks.h', '\n\n'.join(callbacks))
disassembler = (source / 'CachedInterpreter/CachedInterpreter_Disassembler.cpp').read_text()
write('runs-disassembler.h', definition(disassembler, 's32 CachedInterpreter::RunBrowserInterpretOps(std::ostream&'))
print('Extracted actual run callbacks, complete DoJit and flush builders, and 17 pinned handlers')
