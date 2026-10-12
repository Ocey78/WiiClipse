"""Remove the optional compiler's guarded sections for default-path fixtures.

Retains every other upstream conditional verbatim. This also removes the
conditional function split, exposing exactly the default ExecuteOneBlock body.
"""
def without_browser_compiler(text):
    output, depth = [], 0
    for line in text.splitlines(keepends=True):
        directive = line.lstrip()
        if depth:
            if directive.startswith(("#if ", "#ifdef ", "#ifndef ")):
                depth += 1
            elif directive.startswith("#endif"):
                depth -= 1
            continue
        if directive.startswith(("#if ", "#ifdef ")) and "DWEB_BROWSER_COMPILER" in directive:
            depth = 1
        else:
            output.append(line)
    assert depth == 0
    return "".join(output)
