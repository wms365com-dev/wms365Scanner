param([string]$ZipPath, [string]$StagePath, [string]$Version)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stage = [IO.Path]::GetFullPath($StagePath).TrimEnd('\') + '\'
if ((Split-Path -Leaf $StagePath) -notlike ".wms365-update-*") { throw "Invalid update staging directory." }
$archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    $total = 0L
    foreach ($entry in $archive.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $StagePath $entry.FullName))
        if (-not $target.StartsWith($stage, [StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(":") -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Unsafe update archive entry." }
        $total += $entry.Length
        if ($total -gt 300MB) { throw "Update archive is too large." }
    }
} finally { $archive.Dispose() }
Expand-Archive -LiteralPath $ZipPath -DestinationPath $StagePath
$package = Join-Path $StagePath "WMS365 Print Connector"
$manifest = Get-Content -LiteralPath (Join-Path $package "release-manifest.json") -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) { throw "Update version does not match the approved release." }
$node = Join-Path $package "runtime\node.exe"
foreach ($file in @("wms365-print-agent.js", "wms365-print-agent-core.js", "connector-dashboard.js", "connector-updater.js", "connector-security.js")) {
    & $node --check (Join-Path $package $file)
    if ($LASTEXITCODE -ne 0) { throw "Update failed program verification." }
}
& $node (Join-Path $package "connector-security.js")
if ($LASTEXITCODE -ne 0) { throw "Update cryptography module failed to load." }
