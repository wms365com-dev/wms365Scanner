param(
  [switch]$Apply,
  [string]$OrderCode = 'S-ORD101159',
  [string]$Carrier = 'Purolator',
  [string]$Tracking = '520762278809',
  [string]$PriorTracking = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$scriptName = 'ship-wellforia-s-ord101159-20261104.js'
$sourcePath = Join-Path $PSScriptRoot $scriptName
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($sourcePath))
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$applyArg = if ($Apply) { "process.argv.push('--apply');" } else { '' }
$orderEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($OrderCode))
$carrierEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Carrier))
$trackingEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Tracking))
$priorTrackingEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PriorTracking))
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');process.env.TARGET_ORDER_CODE=Buffer.from('$orderEncoded','base64').toString();process.env.TARGET_CARRIER=Buffer.from('$carrierEncoded','base64').toString();process.env.TARGET_TRACKING=Buffer.from('$trackingEncoded','base64').toString();process.env.TARGET_PRIOR_TRACKING=Buffer.from('$priorTrackingEncoded','base64').toString();$applyArg const f=p.join(process.cwd(),'scripts','$scriptName'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"

$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ship-wellforia-orders-20261104'
& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh `
  --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 `
  -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote S-ORD101159 shipment command failed.' }
