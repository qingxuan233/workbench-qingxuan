@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 清玄的工作台
cd /d "%~dp0"

rem ================================================================
rem  启动器：只做三件事 —— 查依赖、拉起 Electron、用证据判断「到底起没起来」
rem
rem  · 日志名一律 ASCII：chcp 65001 下把输出重定向进中文名文件会失败，
rem    而 cmd 报的却是「另一个程序正在使用此文件」，极具误导性（真实踩过）。
rem  · 「起来了」只认本次启动之后新写的 window-visible：
rem    以前在整份 server.log 里找，上一次成功过就会把这一次的失败当成成功。
rem  · 功能路径全部走变量（%~dp0 推导），正文里的中文只用于提示，不参与拼路径。
rem ================================================================

set "DSH_PORT=3083"
set "DSH_CUSTOMER_HOME=%~dp0引擎数据\.dsh"
set "DSH_SHELL_DIR=%~dp0外壳"
set "SHELLDIR=%~dp0外壳"
set "ELECTRON=%~dp0外壳\node_modules\electron\dist\electron.exe"
set "DATA=%~dp0外壳\data"
set "ELOG=%DATA%\startup.log"
set "SLOG=%SHELLDIR%\server.log"
set "FAILCOPY=%DATA%\startup-fail.log"

if not exist "%ELECTRON%" goto needinstall
if not exist "%DATA%" mkdir "%DATA%"

rem ---- 日志自管 ①：自己的流水账超过 256KB 就轮转一份，不让它无限长 ----
call :rotate "%ELOG%" 262144

rem ---- 日志自管 ②：上一次启动的临时输出不再留（失败那次已另存 startup-fail.log）----
del "%DATA%\startup-out-*.log" >nul 2>&1

rem ---- 日志自管 ③：每次启动独立文件名，上一次的窗口占着旧文件也不影响 ----
set "OUTLOG=%DATA%\startup-out-%RANDOM%%RANDOM%.log"

rem ---- 记下 server.log 当前长度：后面只看「这次」新追加的内容 ----
set "LOG_OFF=0"
if exist "%SLOG%" for %%A in ("%SLOG%") do set "LOG_OFF=%%~zA"

>>"%ELOG%" echo ============================================================
>>"%ELOG%" echo [start] %DATE% %TIME%
>>"%ELOG%" echo   exe = %ELECTRON%
>>"%ELOG%" echo   out = %OUTLOG%
>>"%ELOG%" echo   log = %SLOG% (offset %LOG_OFF%)

rem ---- 已经在跑就不再拉第二个：单实例锁会让第二个 Electron 立刻退出，
rem      看起来像「启动失败」，其实只是上一个窗口还开着 ----
netstat -ano -p TCP | findstr /C:"LISTENING" | findstr /C:":3083 " >nul
if not errorlevel 1 goto already

rem 有的环境会把 Electron 当纯 Node 跑（ELECTRON_RUN_AS_NODE=1），清掉它
set "ELECTRON_RUN_AS_NODE="
cd /d "%SHELLDIR%"

rem 本机记录：上次证明 Chromium 沙箱起不来（0x80000003），直接走兼容模式
if exist "%DATA%\no-sandbox.flag" goto compat

echo 正在启动工作台…（窗口关闭后本窗口会自动退出）
call :run ""
set "RC=%ERRORLEVEL%"
call :probe
set "PR=%ERRORLEVEL%"
if "%PR%"=="0" goto ok
if "%PR%"=="1" goto okwarn

rem 窗口没出现：先判是不是沙箱问题，再决定要不要用兼容模式重试一次
if "%RC%"=="-2147483645" goto sandbox
>>"%ELOG%" echo [retry] attempt1 rc=%RC% no window-visible, retry with --no-sandbox
goto retry

:sandbox
rem 退出码 -2147483645 = 0x80000003 = STATUS_BREAKPOINT：Chromium 沙箱初始化失败的特征码
rem 见到它就记下来，以后这台机器直接走兼容模式，不再白失败一次
>>"%DATA%\no-sandbox.flag" echo %DATE% %TIME% sandbox init failed 0x80000003; this machine uses --no-sandbox
>>"%ELOG%" echo [retry] attempt1 rc=%RC% (0x80000003 sandbox), retry with --no-sandbox

:retry
echo.
echo 首次启动没看到窗口（退出码 %RC%），改用兼容模式（--no-sandbox）重试一次…
call :run "--no-sandbox"
set "RC=%ERRORLEVEL%"
call :probe
set "PR=%ERRORLEVEL%"
if "%PR%"=="0" goto ok
if "%PR%"=="1" goto okwarn
goto failed

:compat
>>"%ELOG%" echo [compat] no-sandbox.flag found
call :run "--no-sandbox"
set "RC=%ERRORLEVEL%"
call :probe
set "PR=%ERRORLEVEL%"
if "%PR%"=="0" goto ok
if "%PR%"=="1" goto okwarn
goto failed

:ok
>>"%ELOG%" echo [exit] rc=%RC% %TIME% window-visible + engine ready
if exist "%OUTLOG%" del "%OUTLOG%" >nul 2>&1
exit /b %RC%

:okwarn
>>"%ELOG%" echo [exit] rc=%RC% %TIME% window-visible OK, engine NOT ready（界面会停在引擎失败页）
if exist "%OUTLOG%" del "%OUTLOG%" >nul 2>&1
exit /b %RC%

:already
>>"%ELOG%" echo [skip] port 3083 already listening - workbench already running
echo.
echo 3083 端口已被占用 —— 工作台可能已经在运行了，本次不再重复启动。
echo 界面上没看到窗口时，先找出占用者再试：
echo   netstat -ano ^| findstr :3083
echo.
timeout /t 5 >nul 2>&1
exit /b 0

:failed
>>"%ELOG%" echo [fail] rc=%RC% %TIME% no window-visible after 2 attempts
echo.
echo ============================================================
echo  工作台没能显示窗口（Electron 退出码 %RC%）
echo ============================================================
echo.
echo  ---- 本次启动输出 ----
if exist "%OUTLOG%" type "%OUTLOG%"
if not exist "%OUTLOG%" echo （没有输出文件：重定向本身可能就失败了）
echo.
echo  ---- 外壳服务日志（最后 15 行）----
if exist "%SLOG%" powershell -NoProfile -Command "Get-Content -LiteralPath '%SLOG%' -Tail 15 -Encoding UTF8"
if not exist "%SLOG%" echo （没有 server.log：主进程没执行到日志代码）
echo.
if exist "%OUTLOG%" for %%A in ("%OUTLOG%") do if %%~zA GTR 0 copy /y "%OUTLOG%" "%FAILCOPY%" >nul 2>&1
echo  若本次有输出，已另存为 data\startup-fail.log（下次失败时覆盖）
echo  把上面的内容发给 AI 就能定位。按任意键关闭。
pause >nul
exit /b 1

rem ================= 子过程 =================

:run
rem 参数：额外的 electron 参数（可为空）
>>"%ELOG%" echo [run] electron %~1 . %TIME%
"%ELECTRON%" %~1 . >>"%OUTLOG%" 2>&1
exit /b %ERRORLEVEL%

:probe
rem 返回码 0=窗口+引擎都就绪  1=窗口出现但引擎未就绪  2=窗口没出现
if not exist "%SLOG%" exit /b 2
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%SLOG%'; $o=[int64]%LOG_OFF%; try { $fs=[IO.File]::Open($f,'Open','Read','ReadWrite'); try { if ($o -gt $fs.Length) { $o=0 }; $fs.Position=$o; $sr=New-Object IO.StreamReader($fs,[Text.Encoding]::UTF8); $t=$sr.ReadToEnd() } finally { $fs.Dispose() }; if ($t -notmatch 'window-visible') { exit 2 }; if ($t -match 'engine ready') { exit 0 }; exit 1 } catch { exit 2 }"
exit /b %ERRORLEVEL%

:rotate
rem 参数：文件 上限字节数
if not exist "%~1" exit /b 0
for %%A in ("%~1") do set "ROTSZ=%%~zA"
if not defined ROTSZ exit /b 0
if %ROTSZ% LEQ %~2 exit /b 0
if exist "%~1.prev" del "%~1.prev" >nul 2>&1
move /y "%~1" "%~1.prev" >nul 2>&1
exit /b 0

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
