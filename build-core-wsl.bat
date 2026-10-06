@echo off
setlocal
cd /d "%~dp0"
where wsl >nul 2>nul
if errorlevel 1 (
  echo WSL is not installed. Use native\README.md to build with an activated Emscripten SDK.
  pause
  exit /b 1
)
for /f "delims=" %%I in ('wsl wslpath "%CD%"') do set "WSL_PROJECT=%%I"
echo Building Dolphin WebAssembly core in WSL...
wsl bash -lc "cd '%WSL_PROJECT%' && ./native/bootstrap-emsdk-and-build.sh"
if errorlevel 1 (
  echo.
  echo NATIVE BUILD FAILED
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo Web packaging failed.
  pause
  exit /b 1
)
echo.
echo FULL BUILD OK: dist\
pause
