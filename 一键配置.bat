@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)
node tools\setup-all.mjs "D:\dsh\ai-friend"
pause
