param([string]$Month = '2026-09')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $root 'outputs\wellforia-month-end'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$raw = npx --yes @railway/cli@latest run --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node scripts/export-wellforia-month-end-readonly.js $Month
if ($LASTEXITCODE -ne 0) { throw 'Wellforia month-end read-only export failed.' }
$row = $raw | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($row.reportGzipBase64)
$inputStream = [IO.MemoryStream]::new($bytes)
$gzip = [IO.Compression.GzipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzip)
$json = $reader.ReadToEnd()
$reader.Dispose(); $gzip.Dispose(); $inputStream.Dispose()
$target = Join-Path $outputDir "wellforia-month-end-$Month.json"
[IO.File]::WriteAllText($target, $json, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ outputPath=$target; period=$row.period; outboundLines=$row.outboundLines; inboundLines=$row.inboundLines; inventoryTransactions=$row.inventoryTransactions; billingLines=$row.billingLines } | ConvertTo-Json -Compress
