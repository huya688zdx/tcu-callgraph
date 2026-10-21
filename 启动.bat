@echo off
setlocal
pushd "%~dp0"

set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo   [ERROR] Electron runtime not found.
    echo.
    echo   Open a terminal in this folder and run:
    echo     npm install electron --registry=https://registry.npmmirror.com
    echo.
    pause
    popd
    exit /b 1
)

if "%~1"=="" (
    start /wait "" "node_modules\electron\dist\electron.exe" .
) else (
    start /wait "" "node_modules\electron\dist\electron.exe" . "%~1"
)
set "rc=%errorlevel%"

popd
endlocal & exit /b %rc%
