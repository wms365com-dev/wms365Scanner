$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'verify-zeta-ord-001472-shipped-readonly.js'))
$bytes=[Text.Encoding]::UTF8.GetBytes($source);$stream=[IO.MemoryStream]::new();$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true);$gzip.Write($bytes,0,$bytes.Length);$gzip.Dispose();$encoded=[Convert]::ToBase64String($stream.ToArray());$stream.Dispose()
$remote="const M=require('module'),p=require('path'),z=require('zlib'),f=p.join(process.cwd(),'scripts','verify-zeta-ord-001472-shipped-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$env:RAILWAY_CALLER='skill:use-railway@1.2.3';$env:RAILWAY_AGENT_SESSION='zeta-001472-ship-verify'
& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if($LASTEXITCODE-ne 0){throw 'Remote Zeta shipment verification failed.'}
