@echo off
title Kid Photo Auto-Forwarder
echo ========================================================
echo   WhatsApp Kid-Photo Auto-Forwarder
echo   Local Face Recognition - 100%% Private on Your PC
echo ========================================================
echo.
cd /d "%~dp0"

:: ---------------------------------------------------------
:: 1. Check if Node.js is installed
:: ---------------------------------------------------------
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :node_found

echo [!] Node.js is not detected on your computer.
echo.
echo Node.js is required to run the local forwarder and Web UI.
echo.

where winget >nul 2>nul
if %ERRORLEVEL% NEQ 0 goto :manual_node

echo Windows Package Manager winget was found.
echo Press any key to automatically install Node.js LTS, or close this window.
pause >nul
echo [INFO] Installing Node.js LTS via winget... Please wait...
winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo [INFO] Node.js installation finished.
echo NOTE: You may need to restart this batch file for PATH changes to take effect.
echo Press any key to continue...
pause >nul
goto :verify_node

:manual_node
echo Please download and install the free Node.js LTS installer from:
echo https://nodejs.org
echo.
start https://nodejs.org
echo Press any key once you have completed the installation.
pause >nul

:verify_node
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :node_found

echo [ERROR] Node.js is still not detected in PATH.
echo Please restart your computer or reopen this file after installing Node.js.
pause
exit /b 1

:node_found
:: ---------------------------------------------------------
:: 2. Auto-create .env from example if missing
:: ---------------------------------------------------------
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Setting up default configuration...
        copy .env.example .env >nul
    )
)

:: Ensure runtime folders exist
if not exist "data" mkdir "data"
if not exist "train_photos" mkdir "train_photos"
if not exist "matches_preview" mkdir "matches_preview"
if not exist "logs" mkdir "logs"
if not exist "models" mkdir "models"

:: ---------------------------------------------------------
:: 3. Auto-install dependencies if downloaded from GitHub
:: ---------------------------------------------------------
if not exist "node_modules" goto :install_deps
goto :check_models

:install_deps
echo ========================================================
echo  [FIRST-TIME SETUP] Installing required components...
echo  This only happens once and takes about 1-2 minutes.
echo ========================================================
echo.
call npm install --no-audit --no-fund
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Failed to install dependencies. Please check your internet connection.
    pause
    exit /b 1
)
echo.
echo [OK] Components installed successfully.
echo.

:check_models
:: ---------------------------------------------------------
:: 4. Ensure Face-API models exist
:: ---------------------------------------------------------
if not exist "models\ssd_mobilenetv1_model.bin" (
    echo [INFO] Setting up neural network face models...
    call node download-models.js
)

:: ---------------------------------------------------------
:: 5. Launch App and Web UI
:: ---------------------------------------------------------
echo [INFO] Starting Kid Photo Forwarder...
echo [INFO] Opening dashboard in your browser: http://localhost:4848
echo.
echo [NOTE] Keep this window open while you want monitoring to run.
echo        To stop the forwarder, simply close this window.
echo.

node server.js

echo.
echo App stopped. Press any key to close this window.
pause >nul
