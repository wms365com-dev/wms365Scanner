param([Parameter(Mandatory=$true)][ValidateSet('preflight','apply')][string]$Step)
$ErrorActionPreference='Stop'
$scriptName='receive-putaway-zeta-inb-000215.js'; $source=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $scriptName))
$memory=[IO.MemoryStream]::new(); $gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Compress)
$gzip.Write($source,0,$source.Length); $gzip.Dispose(); $encoded=[Convert]::ToBase64String($memory.ToArray())
$apply=if($Step -eq 'apply'){"process.argv.push('--apply');"}else{''}
$remote="const M=require('node:module'),p=require('node:path'),z=require('node:zlib');${apply}const f=p.join(process.cwd(),'scripts','$scriptName'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
$env:RAILWAY_CALLER='codex:receive-putaway-zeta-inb-000215'
$output=railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if($LASTEXITCODE -ne 0){throw "INB-000215 receive/putaway failed: $Step"}
$output|Where-Object{$_.Trim().StartsWith('{')}|Select-Object -Last 1
