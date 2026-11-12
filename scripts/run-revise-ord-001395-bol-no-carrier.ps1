$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scriptName = 'revise-ord-001395-bol-no-carrier.js'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $scriptName))
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new(); $gzip = [IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true)
$gzip.Write($bytes,0,$bytes.Length); $gzip.Dispose(); $encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$apply = if ($args -contains '--apply') { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$apply const f=p.join(process.cwd(),'scripts','$scriptName'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
$env:RAILWAY_CALLER = 'codex:revise-ord-001395-bol-no-carrier'
$output = railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'ORD-001395 clean BOL generation failed.' }
$json = $output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
$report = $json | ConvertFrom-Json
$pdf = [Convert]::FromBase64String($report.pdfBase64)
$file = Join-Path $root 'outputs\ord-001395-correction\WMS365_BOL_ORD-001395_2026-10-20_10AM_BISON.pdf'
[IO.File]::WriteAllBytes($file,$pdf)
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($pdf)).Replace('-','').ToLowerInvariant()
if ($hash -ne $report.pdfSha256) { throw 'Clean BOL hash mismatch.' }
$report.PSObject.Properties.Remove('pdfBase64'); $report | ConvertTo-Json -Compress
Write-Output "BOL file: $file"
