@echo off
chcp 65001 >nul
title 淋雨家的工作台
cd /d "%~dp0"
set "DSH_PORT=3083"
set "DSH_CUSTOMER_HOME=%~dp0引擎数据\.dsh"
set "DSH_SHELL_DIR=%~dp0外壳"
set "ELECTRON=%~dp0外壳\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
    echo [错误] 未检测到 Electron，请先在外壳目录安装依赖。
    pause
    exit /b 1
)

cd /d "%~dp0外壳"
"%ELECTRON%" .
