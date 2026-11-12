$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'audit-alcona-ord-001395-001396-readonly.js'))
$memory = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GzipStream]::new($memory,[IO.Compression.CompressionMode]::Compress)
$gzip.Write($source,0,$source.Length); $gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$remote = "eval(require('node:zlib').gunzipSync(Buffer.from('$encoded','base64')).toString())"
$env:RAILWAY_CALLER = 'codex:audit-alcona-001395-001396'
$output = railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Alcona two-order audit failed.' }
$dataLine = $output | Where-Object { $_.StartsWith('DATA:') } | Select-Object -First 1
if (-not $dataLine) { throw 'Audit returned no payload.' }
$compressed = [Convert]::FromBase64String($dataLine.Substring(5))
$input = [IO.MemoryStream]::new($compressed)
$gzipIn = [IO.Compression.GzipStream]::new($input,[IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzipIn,[Text.Encoding]::UTF8)
$json = $reader.ReadToEnd(); $reader.Dispose(); $gzipIn.Dispose(); $input.Dispose()
$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\ord-001395-correction'
[IO.Directory]::CreateDirectory($dir) | Out-Null
$target = Join-Path $dir 'preflight.json'
[IO.File]::WriteAllText($target,$json,[Text.UTF8Encoding]::new($false))
$row = $json | ConvertFrom-Json
[pscustomobject]@{ output=$target; orders=$row.orders | Select-Object order_code,status,shipped_at,confirmed_ship_date,po_number,shipping_reference,shipment_email_status; allocations=$row.allocations.Count; shipments=$row.shipments.Count; shipmentLines=$row.shipmentLines.Count; ledger=$row.ledger.Count; documents=$row.docs.Count; billing=$row.billing.Count; emails=$row.emails.Count } | ConvertTo-Json -Depth 6
