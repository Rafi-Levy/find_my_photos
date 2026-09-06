@echo off
echo ========================================
echo  WhatsApp Kid-Photo Auto-Forwarder
echo ========================================
echo.
cd /d "%~dp0"

:: Set AUTO_RESTART_MODE to exit for batch runner to perform full process restart
if "%AUTO_RESTART_MODE%"=="" set AUTO_RESTART_MODE=exit

:run
node index.js
set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% EQU 42 (
    echo.
    echo ========================================================
    echo  [00:00 UTC] Nightly auto-restart triggered.
    echo  Relaunching process in 3 seconds...
    echo ========================================================
    echo.
    timeout /t 3 /nobreak >nul
    goto run
)

echo.
echo Process stopped with exit code %EXIT_CODE%. Press any key to close.
pause >nul
