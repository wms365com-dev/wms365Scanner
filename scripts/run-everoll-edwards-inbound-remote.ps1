param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$railway = 'C:\Users\T470\AppData\Roaming\npm\railway.cmd'
if (-not (Test-Path -LiteralPath $railway)) { throw 'Railway CLI is not installed.' }
$sourcePath = Join-Path $PSScriptRoot 'create-receive-everoll-edwards-20260918.js'
$encoded = & node -e "const fs=require('node:fs'),z=require('node:zlib');process.stdout.write(z.deflateRawSync(fs.readFileSync(process.argv[1])).toString('base64'))" $sourcePath
if ($LASTEXITCODE -ne 0 -or -not $encoded) { throw 'Could not encode the Everoll workflow.' }
$applyFlag = if ($Apply) { 'true' } else { 'false' }
$remote = "const M=require('node:module'),p=require('node:path'),z=require('node:zlib');const f=p.join(process.cwd(),'scripts','create-receive-everoll-edwards-20260918.js');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.inflateRawSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main({apply:$applyFlag}).catch(e=>{console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1})"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'everoll-direct-access-20260923'
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Everoll inbound remote workflow failed.' }
