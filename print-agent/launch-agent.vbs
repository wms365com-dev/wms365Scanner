Option Explicit
Dim shell, fso, base, nodeFile, nodePath, scriptPath, extra, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
nodeFile = fso.BuildPath(base, "node-path.txt")
If Not fso.FileExists(nodeFile) Then
    MsgBox "WMS365 Print Agent is not installed correctly. Run install-windows.ps1 again.", 16, "WMS365 Print Agent"
    WScript.Quit 1
End If
nodePath = Trim(fso.OpenTextFile(nodeFile, 1).ReadAll)
scriptPath = fso.BuildPath(base, "wms365-print-agent.js")
extra = ""
For i = 0 To WScript.Arguments.Count - 1
    extra = extra & " " & WScript.Arguments(i)
Next
shell.CurrentDirectory = base
shell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptPath & Chr(34) & extra, 0, False
