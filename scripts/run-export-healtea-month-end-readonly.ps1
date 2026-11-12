$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'export-healtea-month-end-readonly.js'
$source = [IO.File]::ReadAllBytes($sourcePath)
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','export-healtea-month-end-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1});"
$env:RAILWAY_CALLER = 'codex:healtea-month-end-readonly'
$output = railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Healtea month-end read-only export failed.' }
$outputDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\healtea-month-end'
[IO.Directory]::CreateDirectory($outputDir) | Out-Null
foreach ($line in $output) {
  $text = $line.Trim()
  if (-not $text.StartsWith('{')) { continue }
  $row = $text | ConvertFrom-Json
  if (-not $row.reportGzipBase64 -or -not $row.period) { continue }
  $compressed = [Convert]::FromBase64String($row.reportGzipBase64)
  $input = [IO.MemoryStream]::new($compressed)
  $gzipIn = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
  $reader = [IO.StreamReader]::new($gzipIn, [Text.Encoding]::UTF8)
  $json = $reader.ReadToEnd()
  $reader.Dispose(); $gzipIn.Dispose(); $input.Dispose()
  $target = Join-Path $outputDir "healtea-month-end-$($row.period).json"
  [IO.File]::WriteAllText($target, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{ period=$row.period; outputPath=$target; outboundLines=$row.outboundLines; inboundLines=$row.inboundLines; inventoryTransactions=$row.inventoryTransactions; billingLines=$row.billingLines } | ConvertTo-Json -Compress
}
