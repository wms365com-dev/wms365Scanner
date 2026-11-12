param([ValidateSet('preflight','apply')][string]$Step = 'preflight')
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'ship-zeta-ord-001281-20261006.js'
$source = [IO.File]::ReadAllBytes($sourcePath)
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$applyArg = if ($Step -eq 'apply') { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','ship-zeta-ord-001281-20261006.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$env:RAILWAY_CALLER = "codex:zeta-ord-001281-$Step"
$railway = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd'
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw "Zeta ORD-001281 $Step failed." }
