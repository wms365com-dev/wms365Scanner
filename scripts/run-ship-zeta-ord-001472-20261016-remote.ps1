param([switch]$Apply)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$scriptPath=Join-Path $PSScriptRoot 'ship-zeta-ord-001472-20261016.js'
$pdfPath='C:\Users\T470\Downloads\CamScanner 2026-10-16 10.09.pdf'
if(-not(Test-Path -LiteralPath $pdfPath)){throw 'Reviewed shipment PDF is missing.'}
$bytes=[Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath));$stream=[IO.MemoryStream]::new();$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true);$gzip.Write($bytes,0,$bytes.Length);$gzip.Dispose();$encoded=[Convert]::ToBase64String($stream.ToArray());$stream.Dispose()
$payload=ConvertTo-Json @{script=$encoded;pdf=[Convert]::ToBase64String([IO.File]::ReadAllBytes($pdfPath));apply=[bool]$Apply} -Compress
$bootstrap="const fs=require('fs'),z=require('zlib'),M=require('module'),p=require('path');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const x=JSON.parse(s),pdf='/tmp/ord-001472-evidence.pdf';fs.writeFileSync(pdf,Buffer.from(x.pdf,'base64'));process.env.SOURCE_PDF_PATH=pdf;if(x.apply)process.argv.push('--apply');const f=p.join(process.cwd(),'scripts','ship-zeta-ord-001472-20261016.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from(x.script,'base64')).toString(),f);});"
$env:RAILWAY_CALLER='skill:use-railway@1.2.3';$env:RAILWAY_AGENT_SESSION=if($Apply){'zeta-001472-ship-apply'}else{'zeta-001472-ship-preflight'}
$payload|& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $bootstrap
if($LASTEXITCODE-ne 0){throw 'Remote Zeta shipment command failed.'}
