param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'ship-zeta-ord-001697-20261023.js'
$bolPath = 'C:\Users\T470\Desktop\ORD-001697_BOL.jpeg'
$loadPath = 'C:\Users\T470\Desktop\ORD-001697_loaded.jpeg'
if (-not (Test-Path -LiteralPath $bolPath)) { throw 'Reviewed BOL image is missing.' }
if (-not (Test-Path -LiteralPath $loadPath)) { throw 'Reviewed loaded-shipment image is missing.' }
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath))
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$payload = ConvertTo-Json @{ script=$encoded; bol=[Convert]::ToBase64String([IO.File]::ReadAllBytes($bolPath)); load=[Convert]::ToBase64String([IO.File]::ReadAllBytes($loadPath)); apply=[bool]$Apply } -Compress
$bootstrap = "const fs=require('fs'),z=require('zlib'),M=require('module'),p=require('path');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const x=JSON.parse(s),bol='/tmp/ord-001697-bol.jpeg',load='/tmp/ord-001697-loaded.jpeg';fs.writeFileSync(bol,Buffer.from(x.bol,'base64'));fs.writeFileSync(load,Buffer.from(x.load,'base64'));process.env.SOURCE_BOL_PATH=bol;process.env.SOURCE_LOAD_PATH=load;if(x.apply)process.argv.push('--apply');const f=p.join(process.cwd(),'scripts','ship-zeta-ord-001697-20261023.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from(x.script,'base64')).toString(),f);});"
$env:RAILWAY_CALLER = 'codex:zeta-001697-shipment'
$env:RAILWAY_AGENT_SESSION = if ($Apply) { 'zeta-001697-ship-apply' } else { 'zeta-001697-ship-preflight' }
$payload | & (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Remote ORD-001697 shipment command failed.' }
