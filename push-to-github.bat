@echo off
setlocal

cd /d "%~dp0"

set "REMOTE_URL=https://github.com/wms365com-dev/wms365Scanner.git"
set "COMMIT_MESSAGE=Initial WMS365 Scanner app"

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed or not available in PATH.
    pause
    exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
    echo Initializing git repository...
    git init
    if errorlevel 1 goto :error
)

echo Setting branch to main...
git branch -M main
if errorlevel 1 goto :error

echo Staging files...
git add .
if errorlevel 1 goto :error

git diff --cached --quiet
if errorlevel 1 (
    echo Creating commit...
    git commit -m "%COMMIT_MESSAGE%"
    if errorlevel 1 goto :error
) else (
    echo No staged changes to commit.
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
    echo Adding origin remote...
    git remote add origin "%REMOTE_URL%"
    if errorlevel 1 goto :error
) else (
    echo Updating origin remote...
    git remote set-url origin "%REMOTE_URL%"
    if errorlevel 1 goto :error
)

echo Pushing to GitHub...
git push -u origin main
if errorlevel 1 goto :error

echo.
echo Push complete.
pause
exit /b 0

:error
echo.
echo The script stopped because a git command failed.
pause
exit /b 1
