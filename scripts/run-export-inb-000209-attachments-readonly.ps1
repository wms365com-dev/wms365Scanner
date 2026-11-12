$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'export-inb-000209-attachments-readonly.js'
$source = [IO.File]::ReadAllBytes($sourcePath)
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','export-inb-000209-attachments-readonly.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
$env:RAILWAY_CALLER = 'codex:inb-000209-attachments-readonly'
$railway = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\railway-shim\railway.cmd'
$output = & $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 `
  --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 `
  --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Inbound attachment export failed.' }
$dataLine = $output | Where-Object { $_.StartsWith('DATA:') } | Select-Object -First 1
if (-not $dataLine) { throw 'Inbound attachment export returned no payload.' }
$compressed = [Convert]::FromBase64String($dataLine.Substring(5))
$input = [IO.MemoryStream]::new($compressed)
$gzipIn = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzipIn, [Text.Encoding]::UTF8)
$json = $reader.ReadToEnd()
$reader.Dispose(); $gzipIn.Dispose(); $input.Dispose()
$row = $json | ConvertFrom-Json
$outputDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\inb-000209-attachments'
[IO.Directory]::CreateDirectory($outputDir) | Out-Null
$manifest = [ordered]@{ generatedAt=$row.generatedAt; inbound=$row.inbound; documents=@() }
$index = 0
foreach ($doc in $row.documents) {
  $index++
  $safeName = [IO.Path]::GetFileName([string]$doc.file_name)
  if ([string]::IsNullOrWhiteSpace($safeName)) { $safeName = "attachment-$index.bin" }
  $target = Join-Path $outputDir ('{0:D2}_{1}' -f $index,$safeName)
  [IO.File]::WriteAllBytes($target,[Convert]::FromBase64String([string]$doc.file_base64))
  $manifest.documents += [ordered]@{ id=$doc.id; fileName=$safeName; fileType=$doc.file_type; fileSize=$doc.file_size; category=$doc.document_category; createdAt=$doc.created_at; path=$target }
}
$manifestPath = Join-Path $outputDir 'manifest.json'
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{ inbound=$row.inbound.inbound_code; account=$row.inbound.account_name; status=$row.inbound.status; documents=$row.documents.Count; outputDir=$outputDir } | ConvertTo-Json -Compress
