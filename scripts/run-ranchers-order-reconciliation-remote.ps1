param([ValidateSet('audit','test','apply','release')][string]$Mode='audit')
$ErrorActionPreference='Stop'
$file=Join-Path $PSScriptRoot 'reconcile-ranchers-shopify-orders.js'
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($file)))
$guard=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'designated-test-company.js'))))
$arguments=if($Mode -eq 'audit'){'[]'}else{"['--$Mode']"}
$remote="const M=require('node:module'),p=require('node:path');const gf=p.join(process.cwd(),'scripts','designated-test-company.js'),g=new M(gf,module);g.filename=gf;g.paths=M._nodeModulePaths(p.dirname(gf));g._compile(Buffer.from('$guard','base64').toString(),gf);const f=p.join(process.cwd(),'scripts','reconcile-ranchers-shopify-orders.js');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));const req=m.require.bind(m);m.require=name=>name==='./designated-test-company'?g.exports:req(name);m._compile(Buffer.from('$encoded','base64').toString(),f);m.exports.main($arguments).catch(e=>{console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1;});"
$env:RAILWAY_CALLER='skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION='ranchers-all-orders-reconciliation-20260918'
$output=& railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
$exit=$LASTEXITCODE
$json=$output | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
if(-not $json){throw 'No reconciliation evidence returned'}
$folder=Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs/ranchers-order-reconciliation'
$null=New-Item -ItemType Directory -Path $folder -Force
$path=Join-Path $folder ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$Mode+'.json')
$json | Set-Content -LiteralPath $path -Encoding utf8
Write-Output $json
Write-Output "Evidence: $path"
if($exit -ne 0){throw 'Order reconciliation failed'}
