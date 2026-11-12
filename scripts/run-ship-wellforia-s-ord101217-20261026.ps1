param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$templatePath = Join-Path $PSScriptRoot 'ship-wellforia-s-ord101169-20261001.js'
$source = [IO.File]::ReadAllText($templatePath)
$source = $source.Replace('S-ORD101169', 'S-ORD101217')
$source = $source.Replace('2026-10-01', '2026-10-26')
$source = $source.Replace('47971901', '48565929')
$source = $source.Replace('const EXPECTED_QUANTITY = 144;', 'const EXPECTED_QUANTITY = 248;')
$source = $source.Replace('pallets: 6,', 'pallets: 12,')
$source = $source.Replace('weightLb: 3240,', 'weightLb: 9690,')
$source = $source.Replace('totalPalletsOut: 6, existingPalletsOut: 6,', 'totalPalletsOut: 12, existingPalletsOut: 12,')
$source = $source.Replace('6 pallets, 3,240 lb, quantity 144', '12 pallets, 9,690 lb, quantity 248')
$source = $source.Replace('Owner explicitly approved shipment closeout without a load image or packing slip. Reviewed ILC Logistics BOL 48565929 for S-ORD101217 dated 2026-10-26.', 'Owner explicitly approved shipment closeout without a load image. Reviewed ILC Logistics BOL 48565929 for S-ORD101217; the source BOL is dated 2026-10-16 and the owner-approved actual ship date is 2026-10-26.')
$source = $source.Replace('Owner approved confirmed ship date 2026-10-26. Missing load image and packing slip explicitly waived; BOL 48565929 reviewed as shipment evidence.', 'Owner approved confirmed ship date 2026-10-26. Source BOL 48565929 is dated 2026-10-16; date difference retained in audit note. Missing load image explicitly waived.')
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray()); $stream.Dispose()
$applyArg = if ($Apply) { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','ship-wellforia-s-ord101217-20261026.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$repo = Split-Path -Parent $PSScriptRoot
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'wellforia-s-ord101217-20261104'
& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote Wellforia S-ORD101217 shipment failed.' }
