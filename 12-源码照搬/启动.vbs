' 启动.vbs —— 启动「我的工作台」（公开模板）
Option Explicit
Dim fso, sh, root, shellDir, engineData, electron, env
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shellDir = root & "\外壳"
engineData = root & "\引擎数据\.dsh"
If Not fso.FolderExists(engineData) Then fso.CreateFolder engineData
Set env = sh.Environment("PROCESS")
env("DSH_PORT") = "3083"
env("DSH_CUSTOMER_HOME") = engineData
env("DSH_SHELL_DIR") = shellDir
electron = shellDir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electron) Then
  sh.CurrentDirectory = shellDir
  sh.Run """" & electron & """ .", 1, False
Else
  MsgBox "还没装依赖。在本目录执行：node 工具\初始化.mjs --install" & vbCrLf & shellDir, 48, "我的工作台"
End If
