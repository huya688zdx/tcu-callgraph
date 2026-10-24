@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"

rem 保留独立存档入口；布局和交互与正式版共用。
set "CALLGRAPH_LAYOUT_ENGINE=elk"
if "%~1"=="" (
    call "%~dp0启动.bat" "%~dp0samples\tcu"
) else (
    call "%~dp0启动.bat" "%~1"
)
set "trial_rc=%errorlevel%"
popd
endlocal & exit /b %trial_rc%
