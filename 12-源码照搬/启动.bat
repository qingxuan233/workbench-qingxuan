@echo off
chcp 65001 >nul
rem 有的环境会把 Electron 当纯 Node 跑（ELECTRON_RUN_AS_NODE=1），清掉它
set "ELECTRON_RUN_AS_NODE="
title 我的工作台
cd /d "%~dp0"
set "DSH_PORT=3083"
set "DSH_CUSTOMER_HOME=%~dp0引擎数据\.dsh"
set "DSH_SHELL_DIR=%~dp0外壳"
set "ELECTRON=%~dp0外壳\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto needinstall
cd /d "%~dp0外壳"
"%ELECTRON%" .
exit /b %ERRORLEVEL%

:needinstall
echo.
echo [需要装依赖] 这台机器还没有 Electron（首次部署、或刚 clone 下来都会这样）
echo.
echo   在本目录执行：
echo       node 工具\初始化.mjs --install
echo.
echo   等价于在 外壳 目录执行 npm install（首次约 200 MB，慢属正常）
echo   装完再双击本文件。
echo.
pause
exit /b 1
