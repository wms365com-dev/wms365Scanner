$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'export-ranchers-all-orders-readonly.js'))
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','export-ranchers-all-orders-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ranchers-all-orders-export-20260928'
$output = & (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Read-only Ranchers export failed.' }
$json = $output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
if (-not $json) { throw 'No Ranchers export data returned.' }
$folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\ranchers-all-orders-20260928'
$null = New-Item -ItemType Directory -Path $folder -Force
$path = Join-Path $folder 'source-snapshot.json'
[IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
$result = $json | ConvertFrom-Json
Write-Output (ConvertTo-Json @{ path = $path; readAt = $result.readAt; orders = @($result.orders).Count; counts = $result.counts } -Compress)
