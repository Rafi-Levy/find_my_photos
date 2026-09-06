@echo off
title Create Desktop Shortcut
echo ========================================================
echo   Creating Windows Desktop Shortcut
echo ========================================================
echo.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"

echo.
pause
