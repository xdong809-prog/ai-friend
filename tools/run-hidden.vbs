' Start AI Friend in the background (no window). Log: data\logs\server.log
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\data\logs") Then
  If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
  fso.CreateFolder(root & "\data\logs")
End If
sh.Run "cmd /c node tools\start-qq.mjs --quiet >> data\logs\napcat-launch.log 2>&1", 0, True
sh.Run "cmd /c node server\server.js >> data\logs\server.log 2>&1", 0, False
