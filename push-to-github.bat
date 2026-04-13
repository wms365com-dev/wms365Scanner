@echo off
setlocal EnableExtensions

set "SOURCE_DIR=E:\WMS365Scanner"
set "TARGET_DIR=C:\WMS365Scanner"
set "BRANCH_NAME=main"
set "REMOTE_NAME=origin"

echo.
echo WMS365 Scanner Sync + Push
echo Source: %SOURCE_DIR%
echo Target: %TARGET_DIR%
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed or not available in PATH.
    pause
    exit /b 1
)

if not exist "%SOURCE_DIR%\index.html" (
    echo Missing %SOURCE_DIR%\index.html
    pause
    exit /b 1
)

if not exist "%SOURCE_DIR%\server.js" (
    echo Missing %SOURCE_DIR%\server.js
    pause
    exit /b 1
)

if not exist "%TARGET_DIR%\.git" (
    echo %TARGET_DIR% is not a git repository.
    echo Re-clone the repo into C:\WMS365Scanner before using this script.
    pause
    exit /b 1
)

call :copy_file "index.html"
call :copy_file "server.js"
call :copy_file "package.json"
call :copy_file "package-lock.json"
call :copy_file "railway.json"
call :copy_file "README.md"
call :copy_file ".env.example"
call :copy_file ".gitignore"
call :copy_file "LocationsScanSaveCMV (3).html"
call :copy_file "portal.html"
call :copy_file "login.html"
if errorlevel 1 goto :error

cd /d "%TARGET_DIR%"

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
echo Sync and push complete.
pause
exit /b 0

:copy_file
if exist "%SOURCE_DIR%\%~1" (
    copy /Y "%SOURCE_DIR%\%~1" "%TARGET_DIR%\%~1" >nul
    if errorlevel 1 (
        echo Failed to copy %~1
        exit /b 1
    )
    echo Synced %~1
)
exit /b 0

:error
echo.
echo The script stopped because a sync or git command failed.
pause
exit /b 1
