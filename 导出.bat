@echo off
setlocal
pushd "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo   [ERROR] Node.js is required for CLI export.
    echo   Run: node src\cli\export.js "TARGET" out
    echo.
)

if "%~1"=="" (
    node src\cli\export.js samples\tcu out
) else (
    node src\cli\export.js "%~1" out
)

echo.
echo   Output folder: out\
pause
popd
endlocal
