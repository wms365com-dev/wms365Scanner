param(
  [Parameter(Mandatory=$true)][ValidateSet('correct-preflight','correct-apply','bol-preflight','bol-apply')][string]$Step
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$railway = Join-Path $root 'outputs\railway-shim\railway.cmd'
$scriptName = if ($Step.StartsWith('correct')) { 'correct-ord-001341-pallet-picks.js' } else { 'prepare-ord-001341-bol.js' }
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $scriptName))
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$apply = $Step.EndsWith('apply')
$applyCode = if ($apply) { "process.argv.push('--apply');" } else { '' }
$remote = if ($Step.StartsWith('correct')) {
  "${applyCode}eval(require('node:zlib').gunzipSync(Buffer.from('$encoded','base64')).toString())"
} else {
  "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');${applyCode}const f=p.join(process.cwd(),'scripts','$scriptName'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
}
$env:RAILWAY_CALLER = 'codex:ord-001341-bol'
$output = & $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw "ORD-001341 remote step failed: $Step" }
$json = $output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
if (-not $json) { throw "ORD-001341 remote step returned no JSON: $Step" }
$report = $json | ConvertFrom-Json
if ($Step -eq 'bol-apply') {
  $pdf = [Convert]::FromBase64String($report.pdfBase64)
  $folder = Join-Path $root 'output\pdf'; $null = New-Item -ItemType Directory -Path $folder -Force
  $file = Join-Path $folder 'WMS365_BOL_ORD-001341_2026-10-09.pdf'
  [IO.File]::WriteAllBytes($file, $pdf)
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($pdf)).Replace('-', '').ToLowerInvariant()
  if ($hash -ne $report.pdfSha256) { throw 'Downloaded BOL hash mismatch.' }
  $report.PSObject.Properties.Remove('pdfBase64')
  $report | ConvertTo-Json -Compress
  Write-Output "BOL file: $file"
} else {
  $report | ConvertTo-Json -Compress
}
