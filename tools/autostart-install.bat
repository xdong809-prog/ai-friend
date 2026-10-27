@echo off
setlocal
set "ROOT=%~dp0.."
schtasks /Create /TN "AIFriend" /SC ONLOGON /RL LIMITED /F /TR "wscript.exe \"%ROOT%\tools\run-hidden.vbs\""
if errorlevel 1 (
  echo 设置失败。可以右键这个文件，选“以管理员身份运行”再试一次。
) else (
  echo 已设置：登录 Windows 后会在后台自动启动 AI 好友（没有窗口，日志在 data\logs\server.log）。
  echo 想取消就运行 autostart-remove.bat
)
pause
