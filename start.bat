@echo off
title Kid Photo Auto-Forwarder
echo ========================================================
echo   WhatsApp Kid-Photo Auto-Forwarder
echo   Local Face Recognition - 100%% Private on Your PC
echo ========================================================
echo.
cd /d "%~dp0"

:: Auto-create .env from example if missing
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Setting up default configuration...
        copy .env.example .env >nul
    )
)

:: Ensure required runtime directories exist
if not exist "data" mkdir "data"
if not exist "train_photos" mkdir "train_photos"
if not exist "matches_preview" mkdir "matches_preview"
if not exist "logs" mkdir "logs"
if not exist "models" mkdir "models"

echo [INFO] Launching app and opening browser dashboard...
echo [INFO] Dashboard URL: http://localhost:4848
echo.
echo [NOTE] Keep this window open while you want the app to run.
echo        To stop the forwarder, simply close this window.
echo.

node server.js

echo.
echo App stopped. Press any key to close this window.
pause >nul
