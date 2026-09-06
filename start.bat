@echo off
echo ========================================
echo  WhatsApp Kid-Photo Auto-Forwarder
echo ========================================
echo.
cd /d "%~dp0"

:: Auto-create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        echo Copying default configuration from .env.example...
        copy .env.example .env >nul
    )
)

:: Check if reference embedding exists before starting
if not exist "data\child-reference.json" (
    echo [!] Child face embedding not found.
    echo Launching setup wizard to enroll your child...
    echo.
    call node scripts\setup.js
    if not exist "data\child-reference.json" (
        echo.
        echo [!] Setup was not completed. Please enroll photos before starting.
        goto end
    )
)

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

:end
echo.
if %EXIT_CODE% NEQ 0 (
    echo Tip: Run "npm run doctor" or "setup.bat" to diagnose any issues.
)
echo Process stopped. Press any key to close.
pause >nul
