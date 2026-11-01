# blender-capture.ps1 —— 持续抓 Blender 窗口画面（面板预览用）
#
# 谁在用它：外壳\main.js 的 startBlenderCapture()（无参数拉起，stdio 全 ignore）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File blender-capture.ps1
# 它会：
#   · 把自己的 PID 写进 data\blender-capture.pid（GUI 重启时先 taskkill 掉遗留进程）
#   · 每 ~500ms 找一次 Blender 主窗口，抓一张 JPEG 到 data\blender-live.jpg
#   · 把帧信息写进 data\blender-live.json（at / w / h / seq / ok）
#   · 看到 data\blender-capture.stop 就自己退出；Blender 不在就空转等待（不刷屏、不退出）
#
# 为什么用「屏幕抓取」而不是 PrintWindow：Blender 的视口是 OpenGL 直出，PrintWindow 在
# 多数显卡驱动上拿到的是全黑图；CopyFromScreen 拿到的是用户真正看到的那一块（代价是必须在前台）。
#
# 测试办法（不用装 Blender）：设环境变量 DSH_CAPTURE_PROC=notepad，打开记事本，看 jpg 有没有变。

param(
  [string]$Proc = $(if ($env:DSH_CAPTURE_PROC) { $env:DSH_CAPTURE_PROC } else { 'blender' }),
  [int]$IntervalMs = 500
)

$ErrorActionPreference = 'Continue'
$Data = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'data' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $Data) { $Data = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\data')) }
if (-not (Test-Path $Data)) { New-Item -ItemType Directory -Force -Path $Data | Out-Null }
$Data = (Resolve-Path $Data).Path

$Jpg  = Join-Path $Data 'blender-live.jpg'
$Meta = Join-Path $Data 'blender-live.json'
$PidFile = Join-Path $Data 'blender-capture.pid'
$StopFile = Join-Path $Data 'blender-capture.stop'
$LogFile = Join-Path $Data 'blender-capture.log'

function Write-Log([string]$m) {
  try {
    $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m + "`r`n"
    [System.IO.File]::AppendAllText($LogFile, $line, [System.Text.Encoding]::UTF8)
  } catch { }
}

if (-not ('Cap.W' -as [type])) {
Add-Type -Namespace Cap -Name W -ReferencedAssemblies 'System.Drawing' -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
}
try { [void][Cap.W]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$GW_OWNER = 4

function Get-TopWindows([int]$forPid) {
  $list = New-Object System.Collections.ArrayList
  $cb = [Cap.W+EnumProc]{
    param($h, $l)
    $p = 0
    [void][Cap.W]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $l.ToInt32()) { [void]$list.Add($h) }
    return $true
  }
  [void][Cap.W]::EnumWindows($cb, [IntPtr]$forPid)
  return $list
}

function Get-TargetWindow([string]$procName) {
  if (-not $procName) { return [IntPtr]::Zero }
  $procs = @(Get-Process -Name ($procName -replace '\.exe$', '') -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return [IntPtr]::Zero }
  $best = [IntPtr]::Zero; $bestArea = -1
  foreach ($pr in $procs) {
    foreach ($h in (Get-TopWindows ([int]$pr.Id))) {
      if (-not [Cap.W]::IsWindowVisible($h)) { continue }
      $r = New-Object Cap.W+RECT
      if (-not [Cap.W]::GetWindowRect($h, [ref]$r)) { continue }
      $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      if ($w -lt 120 -or $hh -lt 80) { continue }
      if ([Cap.W]::GetWindowLongPtr($h, $GW_OWNER) -ne [IntPtr]::Zero) { continue }
      if (($w * $hh) -gt $bestArea) { $bestArea = $w * $hh; $best = $h }
    }
  }
  return $best
}

function Write-Meta($obj) {
  try {
    $tmp = $Meta + '.tmp'
    [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Meta -Force
  } catch { }
}

[System.IO.File]::WriteAllText($PidFile, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
Write-Log ('启动抓帧: proc=' + $Proc + ' pid=' + $PID + ' 间隔=' + $IntervalMs + 'ms')
try { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue } catch { }

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]82)

$seq = 0
$lastSig = ''
$misses = 0

while ($true) {
  if (Test-Path -LiteralPath $StopFile) { Write-Log '看到 stop 文件，退出'; break }

  $h = Get-TargetWindow $Proc
  if ($h -eq [IntPtr]::Zero) {
    $misses++
    if ($misses % 20 -eq 1) { Write-Meta @{ ok = $false; err = ('没找到窗口：' + $Proc); at = (Get-Date).ToUniversalTime().ToString('o'); seq = $seq } }
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $misses = 0

  $r = New-Object Cap.W+RECT
  if (-not [Cap.W]::GetWindowRect($h, [ref]$r)) { Start-Sleep -Milliseconds $IntervalMs; continue }
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -lt 80 -or $hh -lt 60) { Start-Sleep -Milliseconds $IntervalMs; continue }

  # 窗口最小化时不抓（会拿到一片桌面）
  if ([Cap.W]::IsIconic($h)) { Start-Sleep -Milliseconds $IntervalMs; continue }

  # 位置/大小没变就隔几帧再抓（省 CPU；Blender 播放动画时窗口不动但画面在变 ⇒ 仍然定时抓）
  $sig = "$($r.Left),$($r.Top),$w,$hh"
  $bmp = $null; $g = $null
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $hh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $tmp = $Jpg + '.tmp'
    if ($jpeg) { $bmp.Save($tmp, $jpeg, $encParams) } else { $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Jpeg) }
    Move-Item -LiteralPath $tmp -Destination $Jpg -Force
    $seq++
    Write-Meta @{ ok = $true; at = (Get-Date).ToUniversalTime().ToString('o'); w = $w; h = $hh; width = $w; height = $hh; seq = $seq; proc = $Proc; jpg = 'blender-live.jpg' }
    $lastSig = $sig
  } catch {
    Write-Log ('抓帧失败: ' + $_.Exception.Message)
    Write-Meta @{ ok = $false; err = $_.Exception.Message; at = (Get-Date).ToUniversalTime().ToString('o'); seq = $seq }
  } finally {
    if ($g) { try { $g.Dispose() } catch { } }
    if ($bmp) { try { $bmp.Dispose() } catch { } }
  }

  Start-Sleep -Milliseconds $IntervalMs
}

try { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue } catch { }
Write-Log '抓帧进程收工'
exit 0
