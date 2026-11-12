$ErrorActionPreference = 'Stop'
$scriptName = 'prepare-ord-001007-bol.js'
$sourcePath = Join-Path $PSScriptRoot $scriptName
$source = [IO.File]::ReadAllText($sourcePath)
$sourceBytes = [Text.Encoding]::UTF8.GetBytes($source)
$compressedStream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($compressedStream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($sourceBytes, 0, $sourceBytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($compressedStream.ToArray())
$compressedStream.Dispose()
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','$scriptName');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1});"

$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'owner-approved-ord-001007-bol'
$output = & (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote BOL preparation failed.' }
$json = $output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
if (-not $json) { throw 'Remote BOL preparation returned no document.' }
$report = $json | ConvertFrom-Json
$pdf = [Convert]::FromBase64String($report.content)
$folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'output\pdf'
$null = New-Item -ItemType Directory -Path $folder -Force
$file = Join-Path $folder $report.filename
[IO.File]::WriteAllBytes($file, $pdf)
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($pdf)).Replace('-', '').ToLowerInvariant()
if ($hash -ne $report.sha256) { throw 'The local PDF does not match the rendered document hash.' }
$report.PSObject.Properties.Remove('content')
$report | ConvertTo-Json -Compress
Write-Output "BOL file: $file"
