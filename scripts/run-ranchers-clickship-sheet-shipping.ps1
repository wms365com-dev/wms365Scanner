param(
    [ValidateSet('audit', 'apply')][string]$Mode = 'audit',
    [string]$SourcePath = 'outputs\ranchers-clickship-queue\sheet1-shipping-20260923.json',
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$ShipDate = (Get-Date -Format 'yyyy-MM-dd'),
    [string[]]$OrderCodes = @(),
    [int]$BatchIndex = -1,
    [ValidateRange(1,20)][int]$BatchSize = 10
)
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) $SourcePath
$bytes = if ($OrderCodes.Count -or $BatchIndex -ge 0) {
    $source = [IO.File]::ReadAllText($sourcePath) | ConvertFrom-Json
    if ($OrderCodes.Count -and $BatchIndex -ge 0) { throw 'Select either OrderCodes or BatchIndex.' }
    if ($OrderCodes.Count) {
        $selected = @($source.rows | Where-Object { $OrderCodes -contains $_.orderCode })
        if ($selected.Count -ne $OrderCodes.Count -or @($OrderCodes | Select-Object -Unique).Count -ne $OrderCodes.Count) {
            throw 'Every selected order must occur exactly once in the source.'
        }
    } else {
        $selected = @($source.rows | Select-Object -Skip ($BatchIndex * $BatchSize) -First $BatchSize)
        if (-not $selected.Count) { throw 'BatchIndex is beyond the source rows.' }
    }
    $batchSource = [ordered]@{
        source = $source.source
        rows = $selected
    }
    [Text.Encoding]::UTF8.GetBytes(($batchSource | ConvertTo-Json -Depth 20 -Compress))
} else {
    [IO.File]::ReadAllBytes($sourcePath)
}
$encoded = [Convert]::ToBase64String($bytes)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sha = ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $sha256.Dispose()
}
$remotePath = '/tmp/ranchers-clickship-sheet1-20260923.json'
$applyCode = if ($Mode -eq 'apply') { "process.argv.push('--apply');process.env.CONFIRM_RANCHERS_DRIVE_SHIPPING='APPROVED_RANCHERS_DRIVE_SHIPPING';" } else { '' }
$remote = "const f=require('fs'),old=f.readFileSync.bind(f);process.env.RANCHERS_SHIPPING_SOURCE_PATH='$remotePath';process.env.RANCHERS_SHIPPING_SOURCE_SHA256='$sha';process.env.RANCHERS_SHIP_DATE='$ShipDate';f.readFileSync=(p,...a)=>String(p)==='$remotePath'?Buffer.from('$encoded','base64'):old(p,...a);$applyCode" + "require('./scripts/process-ranchers-drive-shipping-batch.js');"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = "ranchers-clickship-sheet1-$Mode-20260923"
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw "Ranchers Sheet1 $Mode failed." }
