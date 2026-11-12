$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'export-alcona-august-to-date-2026-readonly.js'
$source = [IO.File]::ReadAllBytes($sourcePath)
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','export-alcona-august-to-date-2026-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$env:RAILWAY_CALLER = 'codex:alcona-august-to-date-readonly'
$railway = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd'
$output = & $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Alcona read-only export failed.' }
$dataLine = $output | Where-Object { $_.StartsWith('DATA:') } | Select-Object -First 1
if (-not $dataLine) { throw 'Alcona export returned no data payload.' }
$compressed = [Convert]::FromBase64String($dataLine.Substring(5))
$input = [IO.MemoryStream]::new($compressed)
$gzipIn = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzipIn, [Text.Encoding]::UTF8)
$json = $reader.ReadToEnd()
$reader.Dispose(); $gzipIn.Dispose(); $input.Dispose()
$outputDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\alcona-august-to-date-2026'
[IO.Directory]::CreateDirectory($outputDir) | Out-Null
$target = Join-Path $outputDir 'source.json'
[IO.File]::WriteAllText($target, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$row = $json | ConvertFrom-Json
[pscustomobject]@{ outputPath=$target; inbounds=$row.inbounds.Count; inboundLines=$row.inboundLines.Count; outbounds=$row.outbounds.Count; outboundLines=$row.outboundLines.Count; billingEvents=$row.billingEvents.Count } | ConvertTo-Json -Compress
