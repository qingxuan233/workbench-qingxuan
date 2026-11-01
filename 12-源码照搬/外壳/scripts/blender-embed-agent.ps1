# blender-embed-agent.ps1 —— Blender 专用入口（薄壳，真逻辑在 app-embed-agent.ps1）
#
# 谁在用它：外壳\main.js 的 blender:embed / embedMove / embedStatus / release 通道。
#   powershell -NoProfile -ExecutionPolicy Bypass -File blender-embed-agent.ps1 `
#              -Cmd <data\blender-embed.cmd.json> -Res <data\blender-embed.res.json> -ParentPid <Electron pid>
#
# 跟通用代理的唯一差别：目标进程写死 blender —— Blender 的窗口类是 GHOST_WindowClass，
# 文件名也常被改成别的；按进程名找（blender.exe / blender），再按"可见 + 面积最大 + 顶层"挑主窗口。
#
# 协议、owner-overlay 的取舍（⛔ 不用 SetParent）、DPI 处理，全部见 app-embed-agent.ps1 头部。

param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][string]$Res,
  [int]$ParentPid = 0,
  [string]$Proc = 'blender',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$agent = Join-Path $PSScriptRoot 'app-embed-agent.ps1'
if (-not (Test-Path -LiteralPath $agent)) {
  # 代理本体不在：写一份能看懂的结果，别让主进程只看到超时
  $err = @{ ok = $false; err = 'blender 代理本体缺失（scripts\app-embed-agent.ps1）'; seq = 0 }
  try {
    [System.IO.File]::WriteAllText($Res + '.tmp', ($err | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath ($Res + '.tmp') -Destination $Res -Force
  } catch { }
  Write-Error $err.err
  exit 1
}

$argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $agent,
  '-Cmd', $Cmd, '-Res', $Res, '-ParentPid', [string]$ParentPid, '-Proc', $Proc)
if ($SelfTest) { $argv += '-SelfTest' }

# 直接前台跑（main.js 用 stdio: 'ignore' 拉起本脚本，这里再拉一层，退出码/信号一路透传）
& powershell.exe @argv
exit $LASTEXITCODE
