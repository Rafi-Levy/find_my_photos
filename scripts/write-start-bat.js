const fs = require('fs');
const path = require('path');

const content = `@echo off
title Kid Photo Auto-Forwarder
echo ========================================================
echo   WhatsApp Kid-Photo Auto-Forwarder
echo   Local Face Recognition - 100%% Private on Your PC
echo ========================================================
echo.
cd /d "%~dp0"

:: 1. Check if Node.js is installed
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js is not detected on your computer.
    echo Please download and install the free Node.js LTS from: https://nodejs.org
    start https://nodejs.org
    echo Press any key once installed...
    pause >nul
    where node >nul 2>nul || (
        echo [ERROR] Node.js is still not detected in PATH.
        pause
        exit /b 1
    )
)

:: 2. Auto-create .env from example if missing
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

:: 3. Auto-install dependencies if downloaded from GitHub
if not exist "node_modules" (
    echo ========================================================
    echo  [FIRST-TIME SETUP] Installing required components...
    echo  This only happens once and takes about 1-2 minutes.
    echo ========================================================
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies. Please check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Components installed successfully.
    echo.
)

:: 4. Ensure Face-API models exist
if not exist "models\\ssd_mobilenetv1_model.bin" (
    echo [INFO] Setting up neural network face models...
    call node download-models.js
)

:: 5. Launch App and Web UI
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
`.replace(/\r?\n/g, '\r\n');

const paths = [
  path.resolve(__dirname, '..', 'start.bat'),
  'C:\\Users\\Lenovo\\Pictures\\test\\find_my_photos\\start.bat'
];

for (const p of paths) {
  try {
    fs.writeFileSync(p, content, 'binary');
    console.log(`Updated ${p} with CRLF line endings.`);
  } catch (err) {
    console.warn(`Could not write to ${p}:`, err.message);
  }
}
