param([ValidateSet('test','apply','verify')][string]$Mode = 'verify')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
$guard = Encode ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'designated-test-company.js')))
$policy = Encode ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'configure-ranchers-shipment-email-optout.js')))
$sql = Encode ([IO.File]::ReadAllText((Join-Path $root 'migrations/20260918_customer_shipment_email_optout.sql')))
$source = @"
const M=require('node:module'),p=require('node:path');
const decode=s=>Buffer.from(s,'base64').toString('utf8');
const gf=p.join(process.cwd(),'scripts','designated-test-company.js');
const g=new M(gf,module);g.filename=gf;g.paths=M._nodeModulePaths(p.dirname(gf));
g._compile(decode('$guard'),gf);
const pf=p.join(process.cwd(),'scripts','configure-ranchers-shipment-email-optout.js');
const m=new M(pf,module);m.filename=pf;m.paths=M._nodeModulePaths(p.dirname(pf));
const req=m.require.bind(m);m.require=name=>name==='./designated-test-company'?g.exports:req(name);
m._compile(decode('$policy'),pf);
m.exports.main(['--$Mode'],decode('$sql')).catch(e=>{console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1;});
"@
$encoded = Encode $source
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ranchers-email-optout-20260918'
railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e "eval(Buffer.from('$encoded','base64').toString())"
if ($LASTEXITCODE -ne 0) { throw "Remote email policy $Mode failed" }
