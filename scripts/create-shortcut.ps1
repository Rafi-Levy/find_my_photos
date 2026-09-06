$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Kid Photo Forwarder.lnk"
$targetPath = Join-Path $PSScriptRoot "..\start.bat"
$targetPath = (Resolve-Path $targetPath).Path

$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = $targetPath
$s.WorkingDirectory = (Split-Path -Parent $targetPath)
$s.Description = "WhatsApp Kid-Photo Auto-Forwarder (Local & Private)"
$s.Save()

if (Test-Path $shortcutPath) {
    Write-Host "[✓] Success! Desktop shortcut created at:"
    Write-Host "    $shortcutPath"
} else {
    Write-Warning "Could not verify shortcut creation."
}
