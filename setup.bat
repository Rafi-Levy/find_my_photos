@echo off
title WhatsApp Kid-Photo Forwarder - Setup
echo ========================================
echo  WhatsApp Kid-Photo Forwarder - Setup
echo ========================================
echo.
cd /d "%~dp0"

if not exist "node_modules" (
    echo [INFO] Installing required dependencies first...
    call npm install --no-audit --no-fund
    if not exist "models\ssd_mobilenetv1_model.bin" (
        call node download-models.js
    )
)

node scripts/setup.js
echo.
pause
