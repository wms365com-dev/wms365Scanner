param([string]$NodeVersion = "24.21.0", [string]$UpdatePublicKeyFile = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Get-WmsFileSha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "") }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $source
if (-not $UpdatePublicKeyFile -and (Test-Path -LiteralPath (Join-Path $source "update-public-key.pem"))) { $UpdatePublicKeyFile = Join-Path $source "update-public-key.pem" }
$version = (Get-Content -LiteralPath (Join-Path $source "package.json") -Raw | ConvertFrom-Json).version
$output = Join-Path $root "outputs\print-connector"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$staging = Join-Path $output ("build-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
$runtimeZip = Join-Path $staging "node.zip"
$archiveName = "node-v$NodeVersion-win-x64.zip"
$runtimeUrl = "https://nodejs.org/dist/v$NodeVersion/$archiveName"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content
    $expected = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $archiveName") }).Trim().Split(" ")[0]
    if (-not $expected -or $expected.Length -ne 64) { throw "Official runtime checksum is missing." }
    Invoke-WebRequest -UseBasicParsing -Uri $runtimeUrl -OutFile $runtimeZip
    if ((Get-WmsFileSha256 $runtimeZip) -ne $expected) { throw "Runtime download verification failed." }
    $package = Join-Path $staging "WMS365 Print Connector"
    $runtime = Join-Path $package "runtime"
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($runtimeZip)
    try {
        foreach ($name in @("node.exe", "LICENSE")) {
            $entry = $archive.GetEntry("node-v$NodeVersion-win-x64/$name")
            if (-not $entry) { throw "Official archive is missing $name." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $name), $true)
        }
    } finally { $archive.Dispose() }
    foreach ($name in @("wms365-print-agent.js", "wms365-print-agent-core.js", "connector-dashboard.js", "connector-updater.js", "connector-security.js", "prepare-update.ps1", "apply-update.ps1", "logo.svg", "package.json", "README.md", "launch-agent.vbs", "install-windows.ps1", "uninstall-windows.ps1", "Install-WMS365.cmd")) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $package
    }
    New-Item -ItemType Directory -Path (Join-Path $package "node_modules") -Force | Out-Null
    $joseSource = Join-Path $root "node_modules\jose"
    $joseVersion = (Get-Content (Join-Path $joseSource "package.json") -Raw | ConvertFrom-Json).version
    $expectedJose = (Get-Content (Join-Path $source "package.json") -Raw | ConvertFrom-Json).dependencies.jose
    if ($joseVersion -ne $expectedJose) { throw "Connector cryptography dependency is not the pinned version." }
    Copy-Item -LiteralPath $joseSource -Destination (Join-Path $package "node_modules") -Recurse
    if ($UpdatePublicKeyFile) {
        & (Join-Path $runtime "node.exe") (Join-Path $source "verify-publisher-key.js") $UpdatePublicKeyFile
        if ($LASTEXITCODE -ne 0) { throw "Invalid publisher public key." }
        Copy-Item -LiteralPath $UpdatePublicKeyFile -Destination (Join-Path $package "update-public-key.pem")
    } else { Write-Warning "No publisher key supplied: OTA will remain disabled in this installation package." }
    $manifest = [ordered]@{
        version = $version; builtAt = [DateTime]::UtcNow.ToString("o"); nodeVersion = $NodeVersion
        nodeArchiveUrl = $runtimeUrl; nodeArchiveSha256 = $expected
        nodeExecutableSha256 = Get-WmsFileSha256 (Join-Path $runtime "node.exe")
        pdfEngineUrl = "https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip"
        pdfEngineSha256 = "98B33A518D42986856D225064B0CD2D3643ECF78CBF84AB873D26CC51877A544"
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $package "release-manifest.json") -Encoding UTF8
    $zip = Join-Path $output "WMS365_Print_Connector_$version`_Windows_x64.zip"
    Compress-Archive -LiteralPath $package -DestinationPath $zip -Force
    Write-Host ("SHA256: " + (Get-WmsFileSha256 $zip))
    Write-Host "Package: $zip"
} finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($output).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe build cleanup path." }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
