@echo off
setlocal

echo ========================================
echo WMS365 Scanner Git Push (Commit First)
echo ========================================

cd /d C:\WMS365Scanner || (
    echo Failed to access C:\WMS365Scanner
    pause
    exit /b 1
)

IF NOT EXIST ".git" (
    echo Initializing repo...
    git init || goto :error
    git branch -M main || goto :error
    git remote add origin https://github.com/wms365com-dev/wms365Scanner.git || goto :error
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
echo Staging local changes...
git add .
if errorlevel 1 goto :error

echo.
echo Creating local commit if needed...
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Local update %date% %time%"
    if errorlevel 1 goto :error
) else (
    echo No local changes to commit.
)

echo.
echo Pulling latest from GitHub with rebase...
git pull origin main --rebase
if errorlevel 1 goto :error

echo.
echo Latest commit:
git log -1 --oneline
if errorlevel 1 goto :error

echo.
echo Pushing to GitHub...
git push -u origin main
if errorlevel 1 goto :error

echo.
echo ========================================
echo PUSH SUCCESSFUL
echo GitHub received the latest commit.
echo Railway should auto-deploy if linked to main.
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
