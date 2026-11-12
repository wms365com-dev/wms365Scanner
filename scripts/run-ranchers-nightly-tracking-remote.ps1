param(
    [ValidateSet('preflight', 'apply', 'audit')]
    [string]$Step = 'preflight'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scriptName = if ($Step -eq 'audit') {
    'audit-ranchers-shopify-delivery-reconciliation-readonly.js'
} else {
    'reconcile-ranchers-shopify-tracking.js'
}
$sourcePath = Join-Path $PSScriptRoot $scriptName
$source = [IO.File]::ReadAllText($sourcePath)
$sourceBytes = [Text.Encoding]::UTF8.GetBytes($source)
$compressedStream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($compressedStream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($sourceBytes, 0, $sourceBytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($compressedStream.ToArray())
$compressedStream.Dispose()
$arguments = if ($Step -eq 'apply') { "['--apply']" } else { '[]' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','$scriptName');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main($arguments).catch(()=>{console.error('NIGHTLY_RECONCILIATION_FAILED');process.exitCode=1});"

$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ranchers-nightly-reconciliation'
$env:NPM_CONFIG_CACHE = Join-Path $root 'outputs\npm-cache'
$null = New-Item -ItemType Directory -Path $env:NPM_CONFIG_CACHE -Force
$output = & (Join-Path $root 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 6e025501-8336-4146-a3c5-ee22758aa83c --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
$exitCode = $LASTEXITCODE
$json = $output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
if (-not $json) { throw 'No verified reconciliation report was returned.' }
$report = $json | ConvertFrom-Json
$folder = Join-Path $root 'outputs/ranchers-nightly-tracking'
$null = New-Item -ItemType Directory -Path $folder -Force
$file = Join-Path $folder ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Step + '.json')
$json | Set-Content -LiteralPath $file -Encoding utf8
Write-Output $json
Write-Output "Evidence: $file"
if ($exitCode -ne 0) { throw 'Remote reconciliation failed; review the saved evidence.' }
