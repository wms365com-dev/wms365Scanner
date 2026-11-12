param([switch]$Apply)
$ErrorActionPreference='Stop'
$sourcePath=Join-Path $PSScriptRoot 'ship-wellforia-jbf-batch-20261006.js'
$bytes=[Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($sourcePath))
$stream=[IO.MemoryStream]::new();$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true)
$gzip.Write($bytes,0,$bytes.Length);$gzip.Dispose();$encoded=[Convert]::ToBase64String($stream.ToArray());$stream.Dispose()
$applyArg=if($Apply){"process.argv.push('--apply');"}else{''}
$remote="const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','ship-wellforia-jbf-batch-20261006.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$repo=Split-Path -Parent $PSScriptRoot
$env:RAILWAY_CALLER='skill:use-railway@1.2.3';$env:RAILWAY_AGENT_SESSION='wellforia-jbf-batch-20261104'
& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if($LASTEXITCODE-ne 0){throw 'Remote Wellforia JBF batch shipment failed.'}
