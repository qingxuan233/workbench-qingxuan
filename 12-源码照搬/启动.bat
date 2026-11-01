@echo off
chcp 65001 >nul
setlocal
title 清玄的工作台
cd /d "%~dp0"
set "DSH_PORT=3083"
set "DSH_CUSTOMER_HOME=%~dp0引擎数据\.dsh"
set "DSH_SHELL_DIR=%~dp0外壳"
set "ELECTRON=%~dp0外壳\node_modules\electron\dist\electron.exe"
set "DATA=%~dp0外壳\data"
set "ELOG=%DATA%\启动日志.txt"

if not exist "%ELECTRON%" goto needinstall
if not exist "%DATA%" mkdir "%DATA%"

rem 只追加不截断：上一次的窗口可能还开着并占用此文件，截断会失败
>>"%ELOG%" echo ============================================================
>>"%ELOG%" echo [start] %DATE% %TIME%
>>"%ELOG%" echo   exe = %ELECTRON%
>>"%ELOG%" echo   src = %~dp0

rem 有的环境会把 Electron 当纯 Node 跑（ELECTRON_RUN_AS_NODE=1），清掉它
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0外壳"

rem 本机记录：上次证明 Chromium 沙箱起不来（0x80000003），直接走兼容模式
if exist "%DATA%\no-sandbox.flag" goto compat

echo 正在启动工作台…（窗口关闭后本窗口会自动退出；日志：外壳\data\启动日志.txt）
call :run ""
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto done

rem 退出码 -2147483645 = 0x80000003 = STATUS_BREAKPOINT：Chromium 沙箱初始化失败的特征码
rem 见到它就记下来，以后不必再白失败一次
if "%RC%"=="-2147483645" >>"%DATA%\no-sandbox.flag" echo %DATE% %TIME% sandbox init failed 0x80000003; this machine uses --no-sandbox
>>"%ELOG%" echo [retry] first attempt exit=%RC%, retry with --no-sandbox
echo.
echo 首次启动未成功，正在用兼容模式（--no-sandbox）重试一次…
call :run "--no-sandbox"
set "RC=%ERRORLEVEL%"
goto done

:compat
>>"%ELOG%" echo [compat] no-sandbox.flag found
call :run "--no-sandbox"
set "RC=%ERRORLEVEL%"

:done
>>"%ELOG%" echo [exit] rc=%RC% %DATE% %TIME%
rem 判据用 ASCII 串：chcp 65001 下 find 对中文串不可靠
find /C "window-visible" "%~dp0外壳\server.log" >nul 2>&1
if errorlevel 1 goto failed
exit /b %RC%

:failed
echo.
echo ============================================================
echo  工作台没能显示窗口（Electron 退出码 %RC%）
echo ============================================================
echo.
echo  ---- 启动日志 ----
type "%ELOG%" 2>nul
echo.
echo  ---- 外壳服务日志（最后 20 行）----
if exist "%~dp0外壳\server.log" powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0外壳\server.log' -Tail 20"
if not exist "%~dp0外壳\server.log" echo （没有 server.log：主进程未执行到日志代码）
echo.
echo  把上面的内容发给 AI 就能定位。按任意键关闭。
pause >nul
exit /b 1

:run
rem 参数：额外 electron 参数（可为空）
>>"%ELOG%" echo [run] electron %~1 .
"%ELECTRON%" %~1 . >>"%ELOG%" 2>&1
exit /b %ERRORLEVEL%

:needinstall
echo.
echo [需要装依赖] 这台机器还没有 Electron（首次部署或刚 git clone 下来都会这样）
echo.
echo   在本目录执行：
echo       node 工具\初始化.mjs --install
echo.
echo   等价于在 外壳 目录 npm install（首次约 200 MB，慢属正常）
echo   装完再双击本文件。
echo.
pause
exit /b 1
