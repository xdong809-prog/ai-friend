@echo off
chcp 936 >nul
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

set "VER="
for /f tokens^=2^ delims^=^" %%v in ('findstr /c:"const VERSION" server\lib\app.js') do set "VER=%%v"

rem 已经关联过 GitHub 仓库：把改动提交并上传
git remote get-url origin >nul 2>nul
if not errorlevel 1 goto UPDATE

git add -A
git commit -q -m "AI 好友 v%VER%"
echo 下面这些文件会上传（config.json 和 data 文件夹不会上传）：
git ls-files | find /c /v ""
echo.
where gh >nul 2>nul
if not errorlevel 1 (
  gh auth status >nul 2>nul
  if not errorlevel 1 goto USEGH
)
echo 请先在浏览器打开 https://github.com/new 新建一个空仓库：名字填 ai-friend，不要勾选添加 README。
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
if errorlevel 1 goto PUSHFAIL
goto RELEASE

:USEGH
echo 检测到已登录的 GitHub 命令行，直接创建私有仓库 ai-friend 并上传……
gh repo create ai-friend --private --source . --remote origin --push
if errorlevel 1 goto PUSHFAIL
goto RELEASE

:UPDATE
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo 没有新的改动，不用提交。
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
git commit -q -m "更新到 v%VER%"
echo 已提交：更新到 v%VER%
:PUSH
echo 正在上传到 GitHub……
git push -u origin main
if errorlevel 1 goto PUSHFAIL

rem 版本号变了（这个版本还没有 Release）：跑测试，通过就自动发布
:RELEASE
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，跳过发布 Release。
  goto END
)
echo.
echo 正在检查 v%VER% 有没有发布过……
node tools\release.mjs --check
if errorlevel 2 goto END
if errorlevel 1 (
  echo 检查失败，这次先不发布 Release。代码已经上传好了。
  goto END
)
choice /c YN /t 15 /d Y /m "把 v%VER% 发布到 GitHub Release 吗？15 秒内不选就自动发布"
if errorlevel 2 (
  echo 已跳过发布。以后再双击这个文件，还会再问。
  goto END
)
if not exist "data\logs" mkdir "data\logs"
echo 发布前先跑一遍全部测试，大约需要十几秒……
node tools\check.mjs > "data\logs\test-result.txt" 2>&1
if errorlevel 1 (
  findstr /b /c:"# pass" /c:"# fail" /c:"语法检查" "data\logs\test-result.txt"
  echo 有测试没通过，这次不发布。结果在 data\logs\test-result.txt
  goto END
)
echo 测试全部通过，开始发布……
node tools\release.mjs
if errorlevel 1 (
  echo 发布失败。代码已经上传好了，修好后再双击这个文件会接着发布。
)
goto END

:PUSHFAIL
echo.
echo 上传失败。常见原因：没联网 / 需要重新登录 GitHub。把上面的英文提示发给 Claude 就行。

:END
echo.
echo 完成。以后改了代码，再双击这个文件就会自动提交并上传；版本号变了还会自动发布 Release。
pause
