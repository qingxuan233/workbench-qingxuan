' 根目录启动器 —— 转发至 12-源码照搬\启动.vbs
Option Explicit
Dim fso, sh, root, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
target = root & "\12-源码照搬\启动.vbs"
If fso.FileExists(target) Then
  sh.Run "wscript.exe """ & target & """", 0, False
Else
  MsgBox "未找到启动入口：" & vbCrLf & target, 48, "淋雨家的工作台"
End If
