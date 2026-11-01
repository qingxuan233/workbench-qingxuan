# app-embed-agent.ps1 —— 把「任意软件的窗口」内置成工作台面板（owner-overlay 方案）
#
# 谁在用它：外壳\main.js 的 appwin:* 通道（面板类型 app），一次只服务一个进程名。
#   powershell -NoProfile -ExecutionPolicy Bypass -File app-embed-agent.ps1 `
#              -Cmd <命令文件> -Res <结果文件> -ParentPid <Electron 进程 pid> -Proc <进程名>
#
# 协议（文件通道，避免 stdio 管道的阻塞坑；main.js 每 40ms 轮询 -Res）：
#   写入 -Cmd：{"seq":N,"cmd":"embed|move|status|release","x":..,"y":..,"w":..,"h":..}
#   写回 -Res：{"seq":N,"ok":true|false,"state":"embedded|released","hwnd":"...","rect":{...}}
#
# ⛔ 为什么不用 SetParent：跨进程 SetParent 之后，被嵌窗口会跟着宿主一起被 DWM 当成同一个
#   窗口来合成 —— 缩放/最小化/DPI 变化时画面撕裂、输入坐标错位，还常常把原程序的菜单吃掉。
#   owner（GWLP_HWNDPARENT=宿主窗口）才是"贴着但不吞"的做法：被嵌窗口保持自己是顶层窗口，
#   永远浮在 owner 之上、跟 owner 一起最小化，位置由我们按**屏幕物理像素**摆。
#
# ⚠ 坐标：main.js 传进来的是屏幕物理像素（已按 scaleFactor 换算）。本进程必须自己声明
#  Per-Monitor DPI aware，否则 125%/150% 缩放下 Windows 会把坐标再缩一次，面板对不上。
#
# 退出：-ParentPid 没了就释放并退出（别留一个孤儿窗口贴在屏幕上）。

param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][string]$Res,
  [int]$ParentPid = 0,
  [string]$Proc = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$LogFile = [System.IO.Path]::ChangeExtension($Res, '.log')

function Write-Log([string]$m) {
  try {
    $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m + "`r`n"
    [System.IO.File]::AppendAllText($LogFile, $line, [System.Text.Encoding]::UTF8)
  } catch { }
}

# ---------- Win32 ----------
if (-not ('Emb.Win32' -as [type])) {
Add-Type -Namespace Emb -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
}

$GWLP_HWNDPARENT = -8
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
$SWP_ASYNCWINDOWPOS = 0x4000
$GW_OWNER = 4

# DPI：先要 PER_MONITOR_AWARE_V2（-4），退而求其次 SetProcessDpiAwareness(2)，再退 SetProcessDPIAware()
try {
  Add-Type -Namespace Emb -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
'@
  [void][Emb.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  try { [void][Emb.Win32]::SetProcessDpiAwareness(2) } catch { try { [void][Emb.Win32]::SetProcessDPIAware() } catch { } }
}

# ---------- 找目标窗口 ----------
function Get-TopWindows([int]$forPid) {
  $list = New-Object System.Collections.ArrayList
  $cb = [Emb.Win32+EnumProc]{
    param($h, $l)
    $p = 0
    [void][Emb.Win32]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $l.ToInt32()) { [void]$list.Add($h) }
    return $true
  }
  [void][Emb.Win32]::EnumWindows($cb, [IntPtr]$forPid)
  return $list
}

function Get-TargetWindow([string]$procName) {
  if (-not $procName) { return [IntPtr]::Zero }
  $procs = @(Get-Process -Name ($procName -replace '\.exe$', '') -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return [IntPtr]::Zero }
  $best = [IntPtr]::Zero; $bestArea = -1
  foreach ($pr in $procs) {
    foreach ($h in (Get-TopWindows ([int]$pr.Id))) {
      if (-not [Emb.Win32]::IsWindowVisible($h)) { continue }
      $r = New-Object Emb.Win32+RECT
      if (-not [Emb.Win32]::GetWindowRect($h, [ref]$r)) { continue }
      $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      if ($w -lt 120 -or $hh -lt 80) { continue }        # 排除工具条/气泡
      $owner = [Emb.Win32]::GetWindowLongPtr($h, $GW_OWNER)
      if ($owner -ne [IntPtr]::Zero) { continue }        # 只看顶层
      $area = $w * $hh
      if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
    }
  }
  return $best
}

# ---------- 状态 ----------
$state = @{
  hwnd      = [IntPtr]::Zero
  pid       = 0
  embedded  = $false
  oldOwner  = [IntPtr]::Zero
  oldRect   = $null
  proc      = $Proc
}

function Get-RectJson([IntPtr]$h) {
  $r = New-Object Emb.Win32+RECT
  if (-not [Emb.Win32]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

function Write-Res($obj) {
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 6
    $tmp = $Res + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Res -Force
  } catch { Write-Log ('写结果失败: ' + $_.Exception.Message) }
}

# SWP_ASYNCWINDOWPOS 是异步的：SetWindowPos 返回时窗口**还没**到位。
# 所以设完要等它真到位（最多 ~600ms）再回话，否则回给 main.js 的 rect 是旧的、面板会抖一下。
function Set-Rect([IntPtr]$h, [int]$x, [int]$y, [int]$w, [int]$hh, [uint32]$extraFlags) {
  $flags = $SWP_NOACTIVATE -bor $SWP_ASYNCWINDOWPOS -bor $extraFlags
  [void][Emb.Win32]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, $flags)
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 50
    $r = New-Object Emb.Win32+RECT
    if ([Emb.Win32]::GetWindowRect($h, [ref]$r)) {
      if ([Math]::Abs($r.Left - $x) -le 2 -and [Math]::Abs($r.Top - $y) -le 2 -and
          [Math]::Abs(($r.Right - $r.Left) - $w) -le 2 -and [Math]::Abs(($r.Bottom - $r.Top) - $hh) -le 2) { break }
    }
  }
  return (Get-RectJson $h)
}

function Resolve-Target($payload) {
  $want = ''
  if ($payload -and $payload.proc) { $want = [string]$payload.proc }
  if (-not $want) { $want = $state.proc }
  if (-not $want) { return [IntPtr]::Zero }
  $h = [IntPtr]$state.hwnd
  if ($h -ne [IntPtr]::Zero -and [Emb.Win32]::IsWindow($h)) { return $h }
  $h = Get-TargetWindow $want
  if ($h -ne [IntPtr]::Zero) {
    $state.hwnd = $h
    $p = 0; [void][Emb.Win32]::GetWindowThreadProcessId($h, [ref]$p); $state.pid = $p
  }
  return $h
}

function Do-Embed($payload) {
  # 目标软件可能刚被拉起：等最多 10 秒
  $h = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $h = Resolve-Target $payload
    if ($h -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($h -eq [IntPtr]::Zero) { throw ('没找到窗口：proc=' + ($(if ($payload.proc) { $payload.proc } else { $state.proc })) + '（软件没开？或者窗口还没出来）') }

  if ([Emb.Win32]::IsIconic($h)) { [void][Emb.Win32]::ShowWindow($h, 9) }   # SW_RESTORE
  if (-not $state.embedded) {
    $state.oldOwner = [Emb.Win32]::GetWindowLongPtr($h, $GWLP_HWNDPARENT)
    $state.oldRect = Get-RectJson $h
    $parent = [IntPtr]::Zero
    # ① 命令里直接给了 parent 窗口句柄（blender 多窗口时按发起内置的那个窗口）→ 优先用它
    if ($payload.parent -and ([string]$payload.parent) -match '^\d+$' -and [int64]$payload.parent -ne 0) {
      $parent = [IntPtr][int64]$payload.parent
    }
    # ② 否则用宿主进程主窗口
    if ($parent -eq [IntPtr]::Zero -and $ParentPid -gt 0) {
      $ph = (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue).MainWindowHandle
      if ($ph -and $ph -ne [IntPtr]::Zero) { $parent = $ph }
    }
    if ($parent -ne [IntPtr]::Zero) {
      [void][Emb.Win32]::SetWindowLongPtr($h, $GWLP_HWNDPARENT, $parent)
    }
  }
  $x = 0; $y = 0; $w = 800; $hhh = 600
  if ($null -ne $payload.x) { $x = [int]$payload.x }
  if ($null -ne $payload.y) { $y = [int]$payload.y }
  if ($null -ne $payload.w) { $w = [int]$payload.w }
  if ($null -ne $payload.h) { $hhh = [int]$payload.h }
  $rect = Set-Rect $h $x $y $w $hhh $SWP_SHOWWINDOW
  $state.embedded = $true
  return @{ ok = $true; state = 'embedded'; hwnd = $h.ToInt64().ToString(); pid = $state.pid; rect = $rect }
}

function Do-Move($payload) {
  $h = Resolve-Target $payload
  if ($h -eq [IntPtr]::Zero) { throw ('没找到窗口：proc=' + $state.proc) }
  if (-not $state.embedded) { return (Do-Embed $payload) }
  $x = 0; $y = 0; $w = 800; $hhh = 600
  if ($null -ne $payload.x) { $x = [int]$payload.x }
  if ($null -ne $payload.y) { $y = [int]$payload.y }
  if ($null -ne $payload.w) { $w = [int]$payload.w }
  if ($null -ne $payload.h) { $hhh = [int]$payload.h }
  $rect = Set-Rect $h $x $y $w $hhh 0
  return @{ ok = $true; state = 'moved'; rect = $rect }
}

function Do-Release() {
  $h = [IntPtr]$state.hwnd
  if ($h -ne [IntPtr]::Zero -and [Emb.Win32]::IsWindow($h)) {
    [void][Emb.Win32]::SetWindowLongPtr($h, $GWLP_HWNDPARENT, $state.oldOwner)
    if ($state.oldRect) {
      [void][Emb.Win32]::SetWindowPos($h, [IntPtr]::Zero, $state.oldRect.x, $state.oldRect.y,
        $state.oldRect.w, $state.oldRect.h, ($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_ASYNCWINDOWPOS))
    }
  }
  $state.embedded = $false
  $state.oldOwner = [IntPtr]::Zero
  return @{ ok = $true; state = 'released' }
}

function Do-Status() {
  $h = [IntPtr]$state.hwnd
  $alive = ($h -ne [IntPtr]::Zero) -and [Emb.Win32]::IsWindow($h)
  return @{
    ok       = $true
    state    = $(if ($state.embedded -and $alive) { 'embedded' } else { 'idle' })
    embedded = [bool]($state.embedded -and $alive)
    hwnd     = $(if ($alive) { $h.ToInt64().ToString() } else { '0' })
    pid      = $state.pid
    proc     = $state.proc
    rect     = $(if ($alive) { Get-RectJson $h } else { $null })
  }
}

# ---------- 自测：-SelfTest 找一次窗口就退出（不写结果文件）----------
if ($SelfTest) {
  $h = Get-TargetWindow $Proc
  $out = @{ ok = ($h -ne [IntPtr]::Zero); proc = $Proc; hwnd = $h.ToInt64().ToString(); rect = (Get-RectJson $h) }
  $out | ConvertTo-Json -Compress
  exit $(if ($h -ne [IntPtr]::Zero) { 0 } else { 1 })
}

Write-Log ('启动 agent: proc=' + $Proc + ' parentPid=' + $ParentPid + ' cmd=' + $Cmd)
Write-Res @{ ok = $true; state = 'started'; seq = 0; proc = $Proc }

# ---------- 主循环 ----------
$parentDead = $false
while ($true) {
  if ($ParentPid -gt 0) {
    $pp = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $pp) { $parentDead = $true; break }
  }
  if (-not (Test-Path -LiteralPath $Cmd)) { Start-Sleep -Milliseconds 120; continue }

  $raw = $null
  try { $raw = [System.IO.File]::ReadAllText($Cmd, [System.Text.Encoding]::UTF8) } catch { Start-Sleep -Milliseconds 120; continue }
  try { Remove-Item -LiteralPath $Cmd -Force -ErrorAction SilentlyContinue } catch { }
  if (-not $raw -or -not $raw.Trim()) { Start-Sleep -Milliseconds 120; continue }

  $payload = $null
  try { $payload = $raw | ConvertFrom-Json } catch { Write-Res @{ ok = $false; err = 'cmd JSON 解析失败' }; continue }

  $seq = 0
  if ($null -ne $payload.seq) { $seq = [int]$payload.seq }
  $cmdName = ([string]$payload.cmd).ToLower()

  $result = $null
  try {
    switch ($cmdName) {
      'embed' { $result = Do-Embed $payload }
      'move' { $result = Do-Move $payload }
      'release' { $result = Do-Release }
      'status' { $result = Do-Status }
      default { $result = @{ ok = $false; err = ('未知命令：' + $cmdName) } }
    }
  } catch {
    $result = @{ ok = $false; err = $_.Exception.Message }
    Write-Log ('命令失败 ' + $cmdName + ': ' + $_.Exception.Message)
  }
  $result['seq'] = $seq
  Write-Res $result
  Write-Log ('seq=' + $seq + ' ' + $cmdName + ' → ' + ($result | ConvertTo-Json -Compress -Depth 4))
  Start-Sleep -Milliseconds 80
}

# 宿主没了：释放并退出（别留一个孤儿窗口贴在屏幕上）
try { [void](Do-Release) } catch { }
Write-Res @{ ok = $true; state = 'parent-exit'; seq = 0 }
Write-Log '宿主进程已退出，agent 收工'
exit 0
