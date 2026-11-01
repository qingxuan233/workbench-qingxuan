@echo off
chcp 65001 >nul
rem ------------------------------------------------------------
rem  自提权（2026-11-02）：本机 explorer.exe 常驻管理员权限，
rem  工作台引擎若以普通权限启动，DSH 的「打开配置文件」等功能
rem  会被 UIPI 拦下（explorer.exe 返回 0xC0000142）。
rem  因此这里先探测管理员身份，不是就以管理员重新拉起自己。
rem  --elevated 标记用于防止提权失败时无限递归。
rem ------------------------------------------------------------
if /i "%~1"=="--elevated" goto :elevated
if "%WB_NO_ELEVATE%"=="1" goto :elevated
net session >nul 2>&1
if errorlevel 1 (
  echo 正在请求管理员权限（本机 explorer 以管理员运行，工作台需要同级）...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs"
  exit /b
)
:elevated
rem ============================================================
rem  根目录启动器：转交给 12-源码照搬\启动.bat
rem
rem  ⚠ 本文件是 UTF-8（无 BOM），而 cmd 默认按系统 OEM 代码页（简中 = 936）
rem    解码批处理正文。所以含中文的行之前必须先把代码页切成 65001，
rem    否则「12-源码照搬」和「启动.bat」都会被读成乱码：
rem      cd 报「系统找不到指定的路径」
rem      call 报「'启动.bat' 不是内部或外部命令」
rem    双击的表现就是一闪而过、什么都没发生（2026-11-01 实际发生）。
rem
rem  另外：%~dp0 结尾自带反斜杠，所以下面是 "%~dp0" + "12-源码照搬\启动.bat"。
rem ============================================================
setlocal
set "WB=%~dp0"
set "LAUNCHER=%WB%12-源码照搬\启动.bat"
if not exist "%LAUNCHER%" goto missing

cd /d "%WB%12-源码照搬"
call "%LAUNCHER%"
exit /b %ERRORLEVEL%

:missing
echo.
echo 找不到启动脚本：
echo   %LAUNCHER%
echo.
echo 确认「12-源码照搬」目录完整（里面应有 启动.bat）。
echo 按任意键关闭。
pause >nul
exit /b 1