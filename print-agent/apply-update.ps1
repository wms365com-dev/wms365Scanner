param([string]$InstallPath, [string]$PackagePath, [int]$OldProcessId, [string]$Version, [int]$Port = 8765)
$ErrorActionPreference = "Stop"
$install = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
$package = [IO.Path]::GetFullPath($PackagePath).TrimEnd('\')
$parent = Split-Path -Parent $install
$stage = Split-Path -Parent $package
if ((Split-Path -Parent $stage) -ne $parent -or (Split-Path -Leaf $stage) -notlike ".wms365-update-*" -or (Split-Path -Leaf $package) -ne "WMS365 Print Connector" -or $install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\')) { throw "Unsafe update installation path." }
$marker = Get-Content -LiteralPath (Join-Path $install "installed.json") -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($marker.installPath).TrimEnd('\') -ne $install) { throw "Update ownership check failed." }
$backup = Join-Path $parent (".wms365-rollback-" + [guid]::NewGuid().ToString("N"))
$log = Join-Path $parent "wms365-update-status.json"
$swapped = $false
$child = $null
$oldExited = $false
try {
    $old = Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue
    if ($old -and -not $old.WaitForExit(60000)) { throw "Connector did not stop safely. Update cancelled." }
    $oldExited = $true
    # Preserve the independent printer engine, device settings and print receipts (stored separately).
    Copy-Item -LiteralPath (Join-Path $install "tools") -Destination $package -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $install "node-path.txt") -Destination $package -Force
    @{ installPath = $install; version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $package "installed.json") -Encoding UTF8
    Move-Item -LiteralPath $install -Destination $backup
    try { Move-Item -LiteralPath $package -Destination $install; $swapped = $true }
    catch { Move-Item -LiteralPath $backup -Destination $install; throw }
    $child = Start-Process -FilePath (Join-Path $install "runtime\node.exe") -WindowStyle Hidden -WorkingDirectory $install -ArgumentList ('"{0}" --background' -f (Join-Path $install "wms365-print-agent.js")) -PassThru
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($child.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.version -eq $Version -and $health.processId -eq $child.Id) { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) { throw "Updated connector did not start. Restoring the previous version." }
    @{ status = "UPDATED"; version = $Version; backup = $backup; at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $log -Encoding UTF8
} catch {
    $failure = $_.Exception.Message
    if ($swapped) {
        if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit(10000) | Out-Null }
        Move-Item -LiteralPath $install -Destination (Join-Path $stage "failed-release")
        Move-Item -LiteralPath $backup -Destination $install
    }
    if ($oldExited -and (Test-Path -LiteralPath (Join-Path $install "installed.json"))) {
        Start-Process -FilePath (Join-Path $install "runtime\node.exe") -WindowStyle Hidden -WorkingDirectory $install -ArgumentList ('"{0}" --background' -f (Join-Path $install "wms365-print-agent.js")) | Out-Null
    }
    @{ status = "ROLLED_BACK_OR_CANCELLED"; version = $Version; message = $failure; at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $log -Encoding UTF8
    exit 1
}
