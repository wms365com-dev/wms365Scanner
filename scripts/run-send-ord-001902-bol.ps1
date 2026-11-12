param([ValidateSet('preflight','apply')][string]$Step = 'preflight')
$ErrorActionPreference = 'Stop'
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ord-001902-bol-dhruv-20261104'
$source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'send-ord-001902-bol-dhruv.js'))
$memory = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$memory.Dispose()
$applyFlag = if ($Step -eq 'apply') { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyFlag const f=p.join(process.cwd(),'scripts','send-ord-001902-bol-dhruv.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
& (Join-Path $PSScriptRoot '..\outputs\railway-shim\railway.cmd') run --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 node -e $remote
if ($LASTEXITCODE -ne 0) { throw "ORD-001902 BOL email failed: $Step" }
