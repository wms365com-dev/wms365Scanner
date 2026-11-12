param([ValidateSet('preflight','apply')][string]$Step = 'preflight')
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'send-ord-002095-bol-dhruv.js'))
$memory = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionLevel]::Optimal, $true)
$gzip.Write($source, 0, $source.Length)
$gzip.Dispose()
$encoded = [Convert]::ToBase64String($memory.ToArray())
$memory.Dispose()
$applyFlag = if ($Step -eq 'apply') { "process.argv.push('--apply');" } else { '' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyFlag const f=p.join(process.cwd(),'scripts','send-ord-002095-bol-dhruv.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
railway run --service wms365Scanner --environment production node -e $remote
if ($LASTEXITCODE -ne 0) { throw "ORD-002095 BOL email failed: $Step" }
