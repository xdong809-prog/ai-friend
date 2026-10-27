@echo off
cd /d "%~dp0"
node tools\setup-all.mjs "D:\dsh\ai-friend" --shortcuts-only
pause
