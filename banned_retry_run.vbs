' WorkBuddy banned-account retry launcher (pure ASCII only).
' Runs one pass of banned-retry.mjs with a HIDDEN window
' (no black console box flashing).
Option Explicit
Dim fso, sh, dir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
cmd = """C:\Program Files\nodejs\node.exe"" """ & fso.BuildPath(dir, "banned-retry.mjs") & """"
sh.Run cmd, 0, False
