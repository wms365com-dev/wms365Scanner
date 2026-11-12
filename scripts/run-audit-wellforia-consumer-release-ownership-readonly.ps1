$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $PSScriptRoot 'audit-wellforia-consumer-release-ownership-readonly.js'
$bytes = [System.IO.File]::ReadAllBytes($sourcePath)
$stream = New-Object System.IO.MemoryStream
$gzip = New-Object System.IO.Compression.GZipStream($stream, [System.IO.Compression.CompressionMode]::Compress)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','audit-wellforia-consumer-release-ownership-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1});"
$railway = Join-Path $root 'outputs\railway-shim\railway.cmd'
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Wellforia consumer release ownership audit failed.' }
