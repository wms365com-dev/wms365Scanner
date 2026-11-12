param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'setup-nommm-canada-company.js'
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath))
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GZipStream($memory, [IO.Compression.CompressionMode]::Compress, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$source = [Convert]::ToBase64String($memory.ToArray())
$memory.Dispose()
$applyArg = if ($Apply) { "process.argv.push('--apply');" } else { "" }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','setup-nommm-canada-company.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$source','base64')).toString(),f);"
$railway = Join-Path $PSScriptRoot '..\outputs\railway-shim\railway.cmd'
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'nommm-company-setup-20261104'
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote NOMMM company setup failed.' }
