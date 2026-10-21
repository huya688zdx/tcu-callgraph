@echo off
setlocal
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js not found in PATH.
    echo   Install Node.js 22+ and run this file again.
    echo.
    pause
    popd
    exit /b 1
)

if "%~1"=="" (
    node src\cli\export.js samples\tcu out
) else (
    node src\cli\export.js "%~1" out
)
set "rc=%errorlevel%"

if not "%rc%"=="0" (
    echo.
    echo   [ERROR] Export failed with exit code %rc%.
    pause
    popd
    exit /b %rc%
)

echo.
echo   Output folder: out\
pause
popd
endlocal & exit /b %rc%
