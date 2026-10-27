@echo off
setlocal
cd /d "%~dp0"
title AI好友
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动 AI 好友，浏览器会自动打开聊天页面。
echo 关闭这个窗口就会停止服务。
set AIF_OPEN=1
node server\server.js
echo.
echo 服务已经停止。
pause
