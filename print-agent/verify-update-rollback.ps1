param([string]$NodePath = "")
$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path (Split-Path -Parent $source) "outputs\print-connector"
$root = Join-Path $output ("ota-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root -Force | Out-Null
if (-not $NodePath) { $NodePath = (Get-Command node.exe).Source }
$previousPort = $env:WMS365_PRINT_AGENT_PORT
$env:WMS365_PRINT_AGENT_PORT = "8859"
$results = @()
try {
    foreach ($fail in @($false, $true)) {
        $case = Join-Path $root $(if ($fail) { "rollback" } else { "success" })
        $install = Join-Path $case "installed"
        $stage = Join-Path $case ".wms365-update-test"
        $package = Join-Path $stage "WMS365 Print Connector"
        foreach ($dir in @($install, $package)) {
            New-Item -ItemType Directory -Path (Join-Path $dir "runtime") -Force | Out-Null
            Copy-Item -LiteralPath $NodePath -Destination (Join-Path $dir "runtime\node.exe")
        }
        New-Item -ItemType Directory -Path (Join-Path $install "tools") | Out-Null
        Set-Content -LiteralPath (Join-Path $install "tools\preserved.txt") -Value "printer-engine"
        Set-Content -LiteralPath (Join-Path $install "node-path.txt") -Value (Join-Path $install "runtime\node.exe")
        @{ installPath = $install; version = "1.3.0" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install "installed.json")
        $oldProgram = 'require("http").createServer((q,r)=>{r.setHeader("Content-Type","application/json");r.end(JSON.stringify({version:"1.3.0",processId:process.pid}))}).listen(8859,"127.0.0.1");'
        $newProgram = $oldProgram.Replace("1.3.0", "1.4.0")
        if ($fail) { $newProgram = "process.exit(1);" }
        Set-Content -LiteralPath (Join-Path $install "wms365-print-agent.js") -Value $oldProgram -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $package "wms365-print-agent.js") -Value $newProgram -Encoding ASCII
        & powershell.exe -NoProfile -File (Join-Path $source "apply-update.ps1") -InstallPath $install -PackagePath $package -OldProcessId 2147483640 -Version "1.4.0" -Port 8859
        $code = $LASTEXITCODE
        $health = $null
        for ($i = 0; $i -lt 30; $i++) {
            try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:8859/health" -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 200 }
        }
        try {
            $expected = $(if ($fail) { "1.3.0" } else { "1.4.0" })
            if (-not $health -or $health.version -ne $expected) { throw "Update/rollback health check failed." }
            if (($fail -and $code -ne 1) -or (-not $fail -and $code -ne 0)) { throw "Unexpected update helper exit status." }
            if ((Get-Content (Join-Path $install "tools\preserved.txt") -Raw).Trim() -ne "printer-engine") { throw "Printer engine was not preserved." }
            $results += @{ scenario = $(if ($fail) { "startup_failure_rollback" } else { "successful_replacement" }); passed = $true; version = $health.version }
        } finally {
            if ($health.processId) {
                $process = Get-Process -Id $health.processId -ErrorAction SilentlyContinue
                if ($process) { $process.Kill(); $process.WaitForExit(10000) | Out-Null }
            }
        }
    }
    @{ testedAt = [DateTime]::UtcNow.ToString("o"); scenarios = $results; productionDatabaseTouched = $false; physicalPrintingTested = $false } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output "ota-verification.json")
    $results | ConvertTo-Json
} finally {
    $env:WMS365_PRINT_AGENT_PORT = $previousPort
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($output).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe test cleanup path." }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
