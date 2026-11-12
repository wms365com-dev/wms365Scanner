$ErrorActionPreference = 'Stop'
$remote = @'
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});await c.connect();
try{const r=await c.query(`select d.file_name,d.file_data from portal_order_documents d join portal_orders o on o.id=d.order_id
where o.order_code='ORD-001698' and o.account_name='ALCONA TRADING LTD' and d.file_name='WMS365_BOL_ORD-001698_2026-10-27_11AM.pdf'`);
if(r.rowCount!==1)throw Error('Saved BOL identity mismatch');const b=Buffer.from(r.rows[0].file_data).toString('base64');
for(let i=0;i<b.length;i+=500)console.log('B64:'+String(i/500).padStart(4,'0')+':'+b.slice(i,i+500));}
finally{await c.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});
'@
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ord-001698-bol-20261026'
$output = npx --yes '@railway/cli' ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'BOL download failed.' }
$chunks = @($output | Where-Object { $_.Trim().StartsWith('B64:') } | ForEach-Object { $_.Trim() } | Sort-Object)
if (-not $chunks.Count) { throw 'BOL content was not returned.' }
$encoded = ($chunks | ForEach-Object { $_.Substring(9) }) -join ''
$folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\ord-001698-bol'
$null = New-Item -ItemType Directory -Path $folder -Force
$path = Join-Path $folder 'WMS365_BOL_ORD-001698_2026-10-27_11AM.pdf'
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($encoded))
Write-Output $path
