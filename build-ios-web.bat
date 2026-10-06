@echo off
setlocal
cd /d "%~dp0"
echo Running tests...
call npm test
if errorlevel 1 goto :fail
echo Building PWA...
call npm run build
if errorlevel 1 goto :fail
echo.
echo BUILD OK: dist\
if not exist public\core\dolphin-core.wasm echo NOTE: Native Dolphin WASM core is not compiled yet. See native\README.md
pause
exit /b 0
:fail
echo.
echo BUILD FAILED
pause
exit /b 1
