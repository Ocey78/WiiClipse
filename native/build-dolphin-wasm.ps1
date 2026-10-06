$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $Bash) {
  throw "bash is required. Use WSL or Git Bash with an activated Emscripten SDK."
}
& $Bash.Source (Join-Path $PSScriptRoot "build-dolphin-wasm.sh")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
