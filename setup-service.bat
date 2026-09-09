@echo off
title Kid Photo Forwarder - Service Setup
echo ========================================================
echo   Kid Photo Forwarder - Background Service Setup
echo ========================================================
echo.
echo This will install the forwarder as a Windows service that
echo starts automatically at boot (no login needed).
echo.
echo Your PC will stay password-protected.
echo.
cd /d "%~dp0"

:: Check for admin privileges
net session >nul 2>&1
if errorlevel 1 (
    echo [!] Administrator privileges required.
    echo     Requesting elevation...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0scripts\install-service.ps1\" && pause' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-service.ps1"
echo.
pause
