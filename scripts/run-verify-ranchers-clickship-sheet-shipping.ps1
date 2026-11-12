param([string]$SourcePath = 'outputs\ranchers-clickship-queue\sheet1-shipping-20260923.json')
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) $SourcePath
$source = [Convert]::ToBase64String([IO.File]::ReadAllBytes($sourcePath))
$scriptPath = Join-Path $PSScriptRoot 'verify-ranchers-clickship-sheet-shipping.js'
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath))
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$remotePath = '/tmp/ranchers-clickship-sheet1-20260923.json'
$remote = "const f=require('fs'),old=f.readFileSync.bind(f),M=require('node:module'),p=require('node:path'),z=require('node:zlib');process.env.RANCHERS_SHIPPING_SOURCE_PATH='$remotePath';f.readFileSync=(x,...a)=>String(x)==='$remotePath'?Buffer.from('$source','base64'):old(x,...a);const n=p.join(process.cwd(),'scripts','verify-ranchers-clickship-sheet-shipping.js'),m=new M(n,module);m.filename=n;m.paths=M._nodeModulePaths(p.dirname(n));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),n);m.exports.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ranchers-clickship-sheet1-verify-20260923'
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Independent Ranchers Sheet1 verification failed.' }
