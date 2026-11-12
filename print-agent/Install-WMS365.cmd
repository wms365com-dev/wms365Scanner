@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
if errorlevel 1 (
  echo Installation could not finish. Please contact WMS365 support with the message above.
  pause
  exit /b 1
)
