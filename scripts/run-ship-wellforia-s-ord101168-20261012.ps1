param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$templatePath = Join-Path $PSScriptRoot 'ship-wellforia-s-ord101169-20261001.js'
$source = [IO.File]::ReadAllText($templatePath)
$source = $source.Replace('S-ORD101169', 'S-ORD101168')
$source = $source.Replace('2026-10-01', '2026-10-12')
$source = $source.Replace('47971901', '48051654')
$source = $source.Replace('const EXPECTED_QUANTITY = 144;', 'const EXPECTED_QUANTITY = 229;')
$source = $source.Replace('pallets: 6,', 'pallets: 11,')
$source = $source.Replace('weightLb: 3240,', 'weightLb: 8939,')
$source = $source.Replace('totalPalletsOut: 6, existingPalletsOut: 6,', 'totalPalletsOut: 11, existingPalletsOut: 11,')
$source = $source.Replace('6 pallets, 3,240 lb, quantity 144', '11 pallets, 8,939 lb, quantity 229')
$source = $source.Replace('Owner explicitly approved shipment closeout without a load image or packing slip. Reviewed ILC Logistics BOL 48051654 for S-ORD101168 dated 2026-10-12.', 'Owner explicitly approved shipment closeout without a load image and other missing shipment proofs. Reviewed ILC Logistics BOL 48051654 for S-ORD101168; the source BOL is dated 2026-10-01 and the owner-approved actual ship date is 2026-10-12.')
$source = $source.Replace('Owner approved confirmed ship date 2026-10-12. Missing load image and packing slip explicitly waived; BOL 48051654 reviewed as shipment evidence.', 'Owner approved confirmed ship date 2026-10-12. Source BOL 48051654 is dated 2026-10-01; date difference retained in audit note. Missing load image and other required shipment proofs explicitly waived.')
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$applyArg = if ($Apply) { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','ship-wellforia-s-ord101168-20261012.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$repo = Split-Path -Parent $PSScriptRoot
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'wellforia-s-ord101168-20261104'
& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote Wellforia S-ORD101168 shipment failed.' }
