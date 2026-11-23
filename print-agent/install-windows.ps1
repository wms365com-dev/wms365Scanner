param(
    [string]$InstallPath = (Join-Path $env:LOCALAPPDATA "WMS365 Print Agent"),
    [switch]$SkipShortcuts,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Get-WmsFileSha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "") }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$sourcePath = Split-Path -Parent $MyInvocation.MyCommand.Path
$installedScript = Join-Path $InstallPath "wms365-print-agent.js"
if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installedScript) }) {
    throw "The installed connector is running. Select Quit in its setup screen, then run installation again."
}
if (-not [Environment]::Is64BitOperatingSystem) { throw "WMS365 Print Connector requires 64-bit Windows." }
$runtime = Join-Path $sourcePath "runtime"
$nodePath = Join-Path $runtime "node.exe"
if (-not (Test-Path -LiteralPath $nodePath)) { throw "The installation package is incomplete. Download a fresh WMS365 Print Connector package." }
$manifest = Get-Content -LiteralPath (Join-Path $sourcePath "release-manifest.json") -Raw | ConvertFrom-Json
if ((Get-WmsFileSha256 $nodePath) -ne $manifest.nodeExecutableSha256) { throw "Runtime verification failed. Do not use this package." }
$major = [int]((& $nodePath --version).TrimStart("v").Split(".")[0])
if ($major -lt 24) { throw "The bundled runtime needs updating." }

# Download the independent PDF engine from its publisher; it is not redistributed by WMS365.
$engineZip = Join-Path $env:TEMP ("wms365-print-engine-" + [guid]::NewGuid().ToString("N") + ".zip")
$engineDirectory = Join-Path $env:TEMP ("wms365-print-engine-" + [guid]::NewGuid().ToString("N"))
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "Preparing the PDF print engine..."
try {
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.pdfEngineUrl -OutFile $engineZip
    if ((Get-WmsFileSha256 $engineZip) -ne $manifest.pdfEngineSha256) { throw "PDF engine verification failed. Installation stopped." }
    Expand-Archive -LiteralPath $engineZip -DestinationPath $engineDirectory
    $engine = Get-ChildItem -LiteralPath $engineDirectory -Filter "*.exe" | Select-Object -First 1
    if (-not $engine) { throw "The PDF print engine is missing." }
    New-Item -ItemType Directory -Path (Join-Path $InstallPath "tools") -Force | Out-Null
    Copy-Item -LiteralPath $engine.FullName -Destination (Join-Path $InstallPath "tools\SumatraPDF.exe") -Force
} finally {
    Remove-Item -LiteralPath $engineZip -Force -ErrorAction SilentlyContinue
    $resolvedTemporary = [IO.Path]::GetFullPath($engineDirectory)
    if (-not $resolvedTemporary.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe temporary cleanup path." }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
$files = @(
    "wms365-print-agent.js",
    "wms365-print-agent-core.js",
    "connector-dashboard.js",
    "connector-updater.js",
    "connector-security.js",
    "prepare-update.ps1",
    "apply-update.ps1",
    "logo.svg",
    "release-manifest.json",
    "package.json",
    "README.md",
    "launch-agent.vbs",
    "uninstall-windows.ps1"
)
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $sourcePath $file) -Destination (Join-Path $InstallPath $file) -Force
}
if (Test-Path -LiteralPath (Join-Path $sourcePath "update-public-key.pem")) {
    Copy-Item -LiteralPath (Join-Path $sourcePath "update-public-key.pem") -Destination $InstallPath -Force
}
Copy-Item -LiteralPath $runtime -Destination $InstallPath -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourcePath "node_modules") -Destination $InstallPath -Recurse -Force
Set-Content -LiteralPath (Join-Path $InstallPath "node-path.txt") -Value (Join-Path $InstallPath "runtime\node.exe") -Encoding ASCII
@{ installPath = [IO.Path]::GetFullPath($InstallPath); version = $manifest.version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallPath "installed.json") -Encoding UTF8

$launcher = Join-Path $InstallPath "launch-agent.vbs"
if (-not $SkipShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $desktopShortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "WMS365 Print Agent.lnk"))
    $desktopShortcut.TargetPath = $wscript
    $desktopShortcut.Arguments = ('"{0}"' -f $launcher)
    $desktopShortcut.WorkingDirectory = $InstallPath
    $desktopShortcut.Description = "Open the WMS365 warehouse print connection"
    $desktopShortcut.Save()

    $startup = [Environment]::GetFolderPath("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startup "WMS365 Print Agent.lnk"))
    $startupShortcut.TargetPath = $wscript
    $startupShortcut.Arguments = ('"{0}" --background' -f $launcher)
    $startupShortcut.WorkingDirectory = $InstallPath
    $startupShortcut.Description = "Start the WMS365 warehouse print connection"
    $startupShortcut.Save()
}

if (-not $NoStart) {
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    Start-Process -FilePath $wscript -WindowStyle Hidden -ArgumentList ('"{0}"' -f $launcher)
}
Write-Host ""
Write-Host "WMS365 Print Agent was installed successfully." -ForegroundColor Green
if (-not $NoStart) {
    Write-Host "The setup screen will open in your browser."
}
if (-not $SkipShortcuts) {
    Write-Host "The agent will also start automatically when this Windows user signs in."
}
