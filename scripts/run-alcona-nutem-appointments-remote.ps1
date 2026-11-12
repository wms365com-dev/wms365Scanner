param(
    [ValidateSet('preflight', 'apply', 'verify')]
    [string]$Step = 'preflight'
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'send-alcona-nutem-pending-appointment-requests.js'
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath))
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$argv = if ($Step -eq 'apply') { "process.argv.push('--apply');" } else { '' }
$remote = "$argv const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','send-alcona-nutem-pending-appointment-requests.js');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"

$env:RAILWAY_CALLER = 'automation:alcona-nutem-nightly-appointments'
$env:RAILWAY_AGENT_SESSION = "alcona-nutem-$Step"
$output = & (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd') ssh `
    --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
    --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
    --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 `
    -- node -e $remote
$exitCode = $LASTEXITCODE

$folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs/alcona-nutem-appointments'
$null = New-Item -ItemType Directory -Path $folder -Force
$evidencePath = Join-Path $folder ((Get-Date -Format 'yyyyMMdd-HHmmss') + "-$Step.json")
$output | Set-Content -LiteralPath $evidencePath -Encoding utf8
$output
Write-Output "Evidence: $evidencePath"

if ($exitCode -ne 0) {
    throw "Alcona/Nutem appointment $Step failed."
}
