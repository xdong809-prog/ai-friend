@echo off
setlocal
cd /d "%~dp0"
title 上传到 GitHub
where git >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Git。请先安装 Git for Windows：https://git-scm.com/download/win ，装好后再双击本文件。
  pause
  exit /b 1
)
if not exist ".git" (
  echo 正在建立本地仓库……
  git init -q
  git fetch -q "%~dp0..\ai-friend.bundle" main
  git reset -q FETCH_HEAD
  git branch -M main
)
git ls-files --error-unmatch config.json >nul 2>nul
if not errorlevel 1 (
  echo 出错：config.json（含 API Key）被纳入了版本库，为了安全已停止。
  pause
  exit /b 1
)

rem GitHub 自动测试的配置放在 tools 里，上传前复制到 .github 文件夹
if exist "tools\github-test.yml" if not exist ".github\workflows\test.yml" (
  mkdir ".github\workflows" 2>nul
  copy /y "tools\github-test.yml" ".github\workflows\test.yml" >nul
)

rem 已经关联过 GitHub 仓库：把改动提交并上传
git remote get-url origin >nul 2>nul
if not errorlevel 1 goto UPDATE

echo 下面这些文件会上传（config.json 和 data 文件夹不会上传）：
git ls-files | find /c /v ""
git status --short
echo.
where gh >nul 2>nul
if not errorlevel 1 (
  gh auth status >nul 2>nul
  if not errorlevel 1 goto USEGH
)
echo 请先在浏览器打开 https://github.com/new 新建一个空仓库：名字填 ai-friend，选 Private，不要勾选添加 README。
echo 建好后，把页面上显示的仓库地址（https://github.com/你的用户名/ai-friend.git）粘贴到这里。
set /p URL=仓库地址：
if "%URL%"=="" (
  echo 没有输入地址，已取消。
  pause
  exit /b 1
)
git remote add origin "%URL%"
echo 正在上传……第一次上传会弹出浏览器让你登录 GitHub。
git push -u origin main
goto END

:USEGH
echo 检测到已登录的 GitHub 命令行，直接创建私有仓库 ai-friend 并上传……
gh repo create ai-friend --private --source . --remote origin --push
goto END

:UPDATE
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo 没有新的改动，不用上传。
  goto PUSH
)
echo 这次改动的文件：
git diff --cached --stat
git diff --cached --name-only | findstr /i /b /c:"config.json" /c:"data/" >nul
if not errorlevel 1 (
  echo 出错：改动里包含 config.json 或 data 文件夹（隐私数据），为了安全已停止。
  git reset -q
  pause
  exit /b 1
)
set "VER="
for /f tokens^=2^ delims^=^" %%v in ('findstr /c:"const VERSION" server\lib\app.js') do set "VER=%%v"
git commit -q -m "更新到 v%VER%"
echo 已提交：更新到 v%VER%
:PUSH
echo 正在上传到 GitHub……
git push -u origin main
if errorlevel 1 (
  echo.
  echo 上传失败。常见原因：没联网 / 需要重新登录 GitHub。把上面的英文提示发给 Claude 就行。
)

:END
echo.
echo 完成。以后改了代码，再双击这个文件就会自动提交并上传。
pause
