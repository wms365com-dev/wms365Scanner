param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'ship-pure-foods-ord-001226-20260924.js'
$plPath = 'C:\Users\T470\Desktop\001226 PL (1).jpeg'
$bolPath = 'C:\Users\T470\Desktop\001226 BOL (1).jpeg'
$phPath = 'C:\Users\T470\Desktop\001226 PH (1).jpeg'
foreach ($path in @($plPath,$bolPath,$phPath)) { if (-not (Test-Path -LiteralPath $path)) { throw "Reviewed shipment evidence is missing: $path" } }
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($scriptPath))
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$payload = ConvertTo-Json @{ script=$encoded; pl=[Convert]::ToBase64String([IO.File]::ReadAllBytes($plPath)); bol=[Convert]::ToBase64String([IO.File]::ReadAllBytes($bolPath)); ph=[Convert]::ToBase64String([IO.File]::ReadAllBytes($phPath)); apply=[bool]$Apply } -Compress
$bootstrap = "const fs=require('fs'),z=require('zlib'),M=require('module'),p=require('path');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const x=JSON.parse(s),pl='/tmp/ord-001226-pl.jpeg',bol='/tmp/ord-001226-bol.jpeg',ph='/tmp/ord-001226-ph.jpeg';fs.writeFileSync(pl,Buffer.from(x.pl,'base64'));fs.writeFileSync(bol,Buffer.from(x.bol,'base64'));fs.writeFileSync(ph,Buffer.from(x.ph,'base64'));process.env.SOURCE_PL_PATH=pl;process.env.SOURCE_BOL_PATH=bol;process.env.SOURCE_PH_PATH=ph;if(x.apply)process.argv.push('--apply');const f=p.join(process.cwd(),'scripts','ship-pure-foods-ord-001226-20260924.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from(x.script,'base64')).toString(),f);});"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = if ($Apply) { 'ord-001226-shipment-apply' } else { 'ord-001226-shipment-preflight' }
$payload | & (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Remote ORD-001226 shipment command failed.' }
