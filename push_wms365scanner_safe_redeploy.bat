@echo off
echo ========================================
echo WMS365 Scanner SAFE Git Push (Railway)
echo ========================================

cd /d E:\WMS365Scanner

IF NOT EXIST ".git" (
    echo Initializing repo...
    git init
    git branch -M main
    git remote add origin https://github.com/wms365com-dev/wms365Scanner.git
)

echo.
echo Checking current status...
git status

echo.
echo Pulling latest version from GitHub...
git pull origin main --rebase

echo.
echo Adding updated files...
git add .

echo.
echo Creating commit...
git commit -m "Auto deploy %date% %time%" 2>nul

echo.
echo Pushing to GitHub (Railway will auto-redeploy)...
git push origin main

echo.
echo ========================================
echo PUSH COMPLETE
echo Railway should start deploying shortly
echo ========================================

pause
