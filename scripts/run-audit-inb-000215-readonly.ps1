$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'audit-inb-000215-readonly.js'))
$memory=[IO.MemoryStream]::new(); $gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Compress)
$gzip.Write($source,0,$source.Length); $gzip.Dispose(); $encoded=[Convert]::ToBase64String($memory.ToArray())
$remote="eval(require('node:zlib').gunzipSync(Buffer.from('$encoded','base64')).toString())"
$env:RAILWAY_CALLER='codex:audit-inb-000215-readonly'
$output=railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if($LASTEXITCODE -ne 0){throw 'INB-000215 audit failed.'}
$json=$output|Where-Object{$_.Trim().StartsWith('{')}|Select-Object -Last 1
$dir=Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\inb-000215'; [IO.Directory]::CreateDirectory($dir)|Out-Null
[IO.File]::WriteAllText((Join-Path $dir 'audit.json'),$json,[Text.UTF8Encoding]::new($false)); $json
