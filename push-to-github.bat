@echo off
setlocal EnableExtensions

set "REPO_DIR=%~dp0"
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"
set "BRANCH_NAME=main"
set "REMOTE_NAME=origin"

echo.
echo WMS365 Scanner Commit + Push
echo Repo: %REPO_DIR%
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed or not available in PATH.
    pause
    exit /b 1
)

if not exist "%REPO_DIR%\.git" (
    echo %REPO_DIR% is not a git repository.
    pause
    exit /b 1
)

cd /d "%REPO_DIR%"

git add -A .
if errorlevel 1 goto :error

git diff --cached --quiet
set "DIFF_EXIT=%ERRORLEVEL%"

if "%DIFF_EXIT%"=="1" goto :commit
if "%DIFF_EXIT%"=="0" goto :push

echo Unable to inspect staged changes.
goto :error

:commit
set "COMMIT_MESSAGE="
set /p "COMMIT_MESSAGE=Commit message (leave blank for default): "
if not defined COMMIT_MESSAGE set "COMMIT_MESSAGE=Sync latest WMS365 Scanner updates"

git commit -m "%COMMIT_MESSAGE%"
if errorlevel 1 goto :error

:push
echo.
echo Pushing to GitHub...
git push -u %REMOTE_NAME% %BRANCH_NAME%
if errorlevel 1 goto :error

echo.
echo Final git status:
git status -sb
if errorlevel 1 goto :error

echo.
echo Latest commit:
git log -1 --oneline
if errorlevel 1 goto :error

echo.
echo Commit and push complete.
pause
exit /b 0

:error
echo.
echo The script stopped because a git command failed.
pause
exit /b 1
