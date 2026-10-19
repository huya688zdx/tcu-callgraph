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

start "" "node_modules\electron\dist\electron.exe" . %*

popd
endlocal
