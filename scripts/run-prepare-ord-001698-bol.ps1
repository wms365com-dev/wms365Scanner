param([switch] $Apply)
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prepare-ord-001698-bol.js') -Raw
$bytes = [Text.Encoding]::UTF8.GetBytes($source)
$memory = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($bytes, 0, $bytes.Length)
$gzip.Close()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$argsJson = if ($Apply) { "['--apply']" } else { '[]' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');process.argv.push(...$argsJson);const f=p.join(process.cwd(),'scripts','prepare-ord-001698-bol.js');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ord-001698-bol-20261026'
npx --yes '@railway/cli' ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'ORD-001698 BOL preparation failed.' }
