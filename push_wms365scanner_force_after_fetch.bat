@echo off
setlocal

echo ========================================
echo WMS365 Scanner Force Push After Fetch
echo ========================================

cd /d C:\WMS365Scanner || (
    echo Failed to access C:\WMS365Scanner
    pause
    exit /b 1
)

IF NOT EXIST ".git" (
    echo This folder is not a git repository.
    pause
    exit /b 1
)

echo.
echo Current branch:
git branch
if errorlevel 1 goto :error

echo.
echo Remote:
git remote -v
if errorlevel 1 goto :error

echo.
echo Aborting any unfinished rebase...
git rebase --abort 2>nul

echo.
echo Staging local changes...
git add .
if errorlevel 1 goto :error

echo.
echo Creating local commit if needed...
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Force deploy local copy %date% %time%"
    if errorlevel 1 goto :error
) else (
    echo No new local changes to commit.
)

echo.
echo Fetching latest remote info...
git fetch origin
if errorlevel 1 goto :error

echo.
echo Latest local commit:
git log -1 --oneline
if errorlevel 1 goto :error

echo.
echo Force pushing local main to GitHub...
git push --force-with-lease origin main
if errorlevel 1 (
    echo.
    echo Force-with-lease was rejected.
    echo Trying full force push because local copy is intended to replace remote main...
    git push --force origin main
    if errorlevel 1 goto :error
)

echo.
echo ========================================
echo FORCE PUSH SUCCESSFUL
echo GitHub now matches your local copy.
echo Railway should auto-deploy from main.
echo ========================================
pause
exit /b 0

:error
echo.
echo ========================================
echo FAILED - check the message above
echo ========================================
pause
exit /b 1
