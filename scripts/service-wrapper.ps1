# scripts/service-wrapper.ps1
# Runs the Kid Photo Forwarder as a background service.
# Called by Task Scheduler at system startup.

$ErrorActionPreference = "Continue"

# Resolve project directory (parent of scripts/)
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectDir

$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$serviceLog = Join-Path $logDir "service.log"
$crashLog   = Join-Path $logDir "crash.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] $msg" | Out-File -Append -FilePath $serviceLog -Encoding UTF8
}

Write-Log "========== SERVICE STARTING =========="
Write-Log "Project: $projectDir"
Write-Log "User: $env:USERNAME"
Write-Log "PID: $PID"

# --- Setup checks (mirrors start.bat but non-interactive) ---

# Node.js check
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Log "[FATAL] Node.js not found in PATH. Cannot start."
    exit 1
}
Write-Log "Node.js: $nodePath"

# Create .env from example if missing
$envFile = Join-Path $projectDir ".env"
$envExample = Join-Path $projectDir ".env.example"
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envFile
    Write-Log "Created .env from .env.example"
}

# Ensure runtime directories
foreach ($dir in @("data", "train_photos", "matches_preview", "logs", "models")) {
    $p = Join-Path $projectDir $dir
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

# npm install if needed
$nodeModules = Join-Path $projectDir "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Log "Installing npm dependencies..."
    $npmResult = & npm install --no-audit --no-fund 2>&1
    $npmResult | Out-File -Append -FilePath $serviceLog -Encoding UTF8
    if ($LASTEXITCODE -ne 0) {
        Write-Log "[FATAL] npm install failed (exit code $LASTEXITCODE)"
        exit 2
    }
    Write-Log "npm install complete."
}

# Download face models if needed
$modelFile = Join-Path $projectDir "models\ssd_mobilenetv1_model.bin"
if (-not (Test-Path $modelFile)) {
    Write-Log "Downloading face-api models..."
    & node (Join-Path $projectDir "download-models.js") 2>&1 |
        Out-File -Append -FilePath $serviceLog -Encoding UTF8
    Write-Log "Model download complete."
}

# --- Start node server.js ---

Write-Log "Starting node server.js..."

# Set NO_OPEN to prevent browser auto-open in service mode
$env:NO_OPEN = "true"

# Rotate service log if it's too large (>10MB)
if ((Test-Path $serviceLog) -and (Get-Item $serviceLog).Length -gt 10MB) {
    $rotated = "$serviceLog.$(Get-Date -Format 'yyyyMMdd-HHmmss').old"
    Move-Item $serviceLog $rotated -Force
    Write-Log "Log rotated. Previous log: $rotated"
}

# Run node and capture output
$process = Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory $projectDir `
    -NoNewWindow `
    -RedirectStandardOutput "$logDir\service-stdout.log" `
    -RedirectStandardError "$logDir\service-stderr.log" `
    -PassThru

Write-Log "node server.js started (PID: $($process.Id))"

# Remove watchdog alert flag since service is running
$flagFile = Join-Path $logDir ".watchdog-alerted"
if (Test-Path $flagFile) { Remove-Item $flagFile -Force }

# Wait for process to exit
$process.WaitForExit()
$exitCode = $process.ExitCode

$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

if ($exitCode -ne 0) {
    $crashMsg = "[$ts] CRASH: node server.js exited with code $exitCode"
    Write-Log $crashMsg
    $crashMsg | Out-File -Append -FilePath $crashLog -Encoding UTF8

    # Write to Windows Event Log for visibility
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists("PhotoForwarder")) {
            New-EventLog -LogName Application -Source "PhotoForwarder" -ErrorAction SilentlyContinue
        }
        Write-EventLog -LogName Application -Source "PhotoForwarder" `
            -EntryType Error -EventId 1001 `
            -Message "Kid Photo Forwarder crashed with exit code $exitCode at $ts. Check logs at: $logDir"
    } catch {
        Write-Log "Could not write to Event Log: $_"
    }
} else {
    Write-Log "node server.js stopped normally (exit code 0)"
    "[$ts] Normal stop (exit code 0)" | Out-File -Append -FilePath $crashLog -Encoding UTF8
}

Write-Log "========== SERVICE STOPPED =========="
exit $exitCode
