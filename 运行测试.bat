@echo off
setlocal
cd /d "%~dp0"
title 运行测试
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)
if not exist "data\logs" mkdir "data\logs"
echo 正在运行全部测试，大约需要十几秒……
node -v > "data\logs\test-result.txt" 2>&1
node tools\check.mjs >> "data\logs\test-result.txt" 2>&1
if errorlevel 1 (
  echo 有测试没通过，结果在 data\logs\test-result.txt
) else (
  echo 全部通过。结果在 data\logs\test-result.txt
)
findstr /b /c:"# pass" /c:"# fail" /c:"语法检查" "data\logs\test-result.txt"
timeout /t 8 >nul
