@echo off
setlocal
cd /d "%~dp0"
echo 这个脚本会从旧项目里【只读】复制：API Key、主人 QQ、NapCat 设置、好友设定、和主人的聊天记录与记忆。
echo 旧项目本身不会被修改。默认旧项目位置：D:\dsh\ai-friend
echo.
set /p OLD=回车使用默认位置，或者输入旧项目的文件夹路径：
if "%OLD%"=="" set OLD=D:\dsh\ai-friend
node tools\import-old.mjs "%OLD%"
pause
