param([Parameter(Mandatory=$true)][string[]]$OrderCode)
$ErrorActionPreference='Stop'
$source=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'read-ranchers-label-rows-by-order.js'))))
$argsJson=ConvertTo-Json -Compress -InputObject @($OrderCode)
$argsEncoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argsJson))
$remote="const M=require('node:module'),p=require('node:path');const f=p.join(process.cwd(),'scripts','read-ranchers-label-rows-by-order.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(Buffer.from('$source','base64').toString(),f);const a=JSON.parse(Buffer.from('$argsEncoded','base64').toString());m.exports.main(a).catch(e=>{console.error(e.stack||e.message);process.exitCode=1});"
$railway = Join-Path $env:APPDATA 'npm\railway.ps1'
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if($LASTEXITCODE-ne 0){throw 'Remote Ranchers label-row read failed.'}
