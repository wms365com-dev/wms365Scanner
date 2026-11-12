param([Parameter(Mandatory = $true)][string]$Reference)

$ErrorActionPreference = 'Stop'
$scriptName = 'inspect-sales-order-reference-readonly.js'
$sourcePath = Join-Path $PSScriptRoot $scriptName
$source = [IO.File]::ReadAllText($sourcePath)
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$stream = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$referenceEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Reference))
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');process.argv[2]=Buffer.from('$referenceEncoded','base64').toString();const f=p.join(process.cwd(),'scripts','$scriptName');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"

$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'sales-order-reference-inspection'
& railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 6e025501-8336-4146-a3c5-ee22758aa83c --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Remote read-only inspection failed.' }
