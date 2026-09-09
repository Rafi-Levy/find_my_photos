# scripts/install-service.ps1
# Creates or removes Task Scheduler tasks for the Kid Photo Forwarder service.
# Must be run as Administrator.

param(
    [switch]$Remove
)

$serviceName  = "PhotoForwarder-Service"
$watchdogName = "PhotoForwarder-Watchdog"
$projectDir   = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# --- Remove mode ---
if ($Remove) {
    Write-Host "`n[INFO] Removing Task Scheduler tasks..." -ForegroundColor Yellow

    foreach ($name in @($serviceName, $watchdogName)) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($existing) {
            if ($existing.State -eq "Running") {
                Stop-ScheduledTask -TaskName $name
                Write-Host "  Stopped: $name"
            }
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "  Removed: $name" -ForegroundColor Green
        } else {
            Write-Host "  Not found: $name (already removed)" -ForegroundColor DarkGray
        }
    }

    # Clean up alert flag
    $flagFile = Join-Path $projectDir "logs\.watchdog-alerted"
    if (Test-Path $flagFile) { Remove-Item $flagFile -Force }

    Write-Host "`n[OK] All tasks removed.`n" -ForegroundColor Green
    exit 0
}

# --- Install mode ---

Write-Host "`n========================================================"
Write-Host "  Kid Photo Forwarder - Service Installation"
Write-Host "========================================================`n"

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] This script must be run as Administrator." -ForegroundColor Red
    Write-Host "        Right-click and select 'Run as administrator'" -ForegroundColor Yellow
    exit 1
}

$username = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Service will run as: $username" -ForegroundColor Cyan
Write-Host ""

# Prompt for password (required for "Run whether user is logged on or not")
$securePass = Read-Host "Enter your Windows password for '$env:USERNAME'" -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential($username, $securePass)
$plainPass = $credential.GetNetworkCredential().Password

if ([string]::IsNullOrEmpty($plainPass)) {
    Write-Host "[ERROR] Password cannot be empty." -ForegroundColor Red
    exit 1
}

# --- 1. Create the main service task ---

Write-Host "`n[Step 1/2] Creating service task: $serviceName"

$wrapperScript = Join-Path $PSScriptRoot "service-wrapper.ps1"

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq "Running") {
        Stop-ScheduledTask -TaskName $serviceName
    }
    Unregister-ScheduledTask -TaskName $serviceName -Confirm:$false
    Write-Host "  Replaced existing task."
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperScript`"" `
    -WorkingDirectory $projectDir

$trigger = New-ScheduledTaskTrigger -AtStartup

# Add a 30-second delay to let the network come up after boot
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 0

try {
    Register-ScheduledTask -TaskName $serviceName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Kid Photo Forwarder - WhatsApp auto-forward service. Starts at boot, runs in background." `
        -User $username `
        -Password $plainPass `
        -RunLevel Highest `
        -Force -ErrorAction Stop | Out-Null
    Write-Host "  [OK] Service task created." -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Failed to create service task: $_" -ForegroundColor Red
    exit 1
}

# --- 2. Create the watchdog task ---

Write-Host "`n[Step 2/2] Creating watchdog task: $watchdogName"

$watchdogScript = Join-Path $PSScriptRoot "service-watchdog.ps1"

$existing = Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false
}

$wdAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogScript`""

# Trigger at any user logon
$wdTrigger = New-ScheduledTaskTrigger -AtLogOn

# Add repetition: check every 5 minutes after logon, indefinitely
$wdTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At "00:00" `
    -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition

$wdSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $watchdogName `
    -Action $wdAction `
    -Trigger $wdTrigger `
    -Settings $wdSettings `
    -Description "Kid Photo Forwarder - Watchdog. Checks every 5 min and alerts if the service is down." | Out-Null

Write-Host "  [OK] Watchdog task created." -ForegroundColor Green

# Clear password from memory
$plainPass = $null
[GC]::Collect()

Write-Host "`n========================================================"
Write-Host "  [OK] Installation complete!"
Write-Host "========================================================`n"
Write-Host "  Service task:   $serviceName  (runs at boot)"
Write-Host "  Watchdog task:  $watchdogName (alerts if service is down)"
Write-Host "  Web dashboard:  http://localhost:4848"
Write-Host "  Service log:    logs\service.log"
Write-Host "  Crash log:      logs\crash.log"
Write-Host ""
Write-Host "  To start NOW without rebooting:"
Write-Host "    schtasks /Run /TN '$serviceName'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To stop the service:"
Write-Host "    schtasks /End /TN '$serviceName'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To uninstall everything:"
Write-Host "    .\remove-service.bat  (as admin)" -ForegroundColor Cyan
Write-Host ""
