@echo off
title Kid Photo Forwarder - Remove Service
echo ========================================================
echo   Kid Photo Forwarder - Remove Background Service
echo ========================================================
echo.
cd /d "%~dp0"

:: Check for admin privileges
net session >nul 2>&1
if errorlevel 1 (
    echo [!] Administrator privileges required.
    echo     Requesting elevation...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0scripts\install-service.ps1\" -Remove && pause' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-service.ps1" -Remove
echo.
pause
