# scripts/service-watchdog.ps1
# Checks if the Kid Photo Forwarder service is running.
# Shows a Windows notification if it's not reachable.
# Runs at user logon + every 5 minutes via Task Scheduler.

$ErrorActionPreference = "SilentlyContinue"

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$flagFile = Join-Path $projectDir "logs\.watchdog-alerted"

# Check if the scheduled task exists
$task = Get-ScheduledTask -TaskName "PhotoForwarder-Service" 2>$null
if (-not $task) {
    # Task doesn't exist — nothing to watch
    exit 0
}

# Try to reach the web server
$alive = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:4848/api/status" `
        -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $alive = $true }
} catch {}

if ($alive) {
    # Service is running — clear any previous alert flag
    if (Test-Path $flagFile) { Remove-Item $flagFile -Force }
    exit 0
}

# Service is NOT running — check if we already alerted for this outage
if (Test-Path $flagFile) {
    # Already alerted, don't spam notifications
    exit 0
}

# Mark that we've alerted for this outage
"Alerted at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File $flagFile -Encoding UTF8

# Show Windows tray notification
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$balloon = New-Object System.Windows.Forms.NotifyIcon
$balloon.Icon = [System.Drawing.SystemIcons]::Warning
$balloon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
$balloon.BalloonTipTitle = "Kid Photo Forwarder - ALERT"
$balloon.BalloonTipText = "The forwarder service is NOT running!`nCheck logs\crash.log for details or run start.bat manually."
$balloon.Visible = $true
$balloon.ShowBalloonTip(15000)

# Play alert sounds
[Console]::Beep(800, 400)
Start-Sleep -Milliseconds 200
[Console]::Beep(800, 400)
Start-Sleep -Milliseconds 200
[Console]::Beep(1000, 600)

# Keep the notification visible, then clean up
Start-Sleep -Seconds 16
$balloon.Dispose()
