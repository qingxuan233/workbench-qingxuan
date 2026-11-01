' start.vbs -- launch the workbench without a console window.
' The real launcher logic lives in ??.bat; this file only hides the window.
Option Explicit
Dim fso, sh, root, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
bat = root & "\" & ChrW(21551) & ChrW(21160) & ".bat"
If Not fso.FileExists(bat) Then
  MsgBox "start.bat is missing next to this file.", 16, "Workbench"
  WScript.Quit 1
End If
sh.CurrentDirectory = root
sh.Run """" & bat & """", 0, False