$ErrorActionPreference = 'Stop'
$remote = @'
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});await c.connect();
try{const r=await c.query(`select d.file_data from portal_order_documents d join portal_orders o on o.id=d.order_id
where o.order_code='ORD-002095' and o.account_name='ALCONA TRADING LTD'
and d.file_name='WMS365_BOL_ORD-002095_2026-11-02_330PM.pdf'`);
if(r.rowCount!==1)throw Error('Saved BOL identity mismatch');const b=Buffer.from(r.rows[0].file_data).toString('base64');
for(let i=0;i<b.length;i+=500)console.log('B64:'+String(i/500).padStart(4,'0')+':'+b.slice(i,i+500));}
finally{await c.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});
'@
$output = railway run --service wms365Scanner --environment production node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'BOL download failed.' }
$chunks = @($output | Where-Object { $_.Trim().StartsWith('B64:') } | ForEach-Object { $_.Trim() } | Sort-Object)
if (-not $chunks.Count) { throw 'BOL content was not returned.' }
$encoded = ($chunks | ForEach-Object { $_.Substring(9) }) -join ''
$folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\ord-002095-bol'
$null = New-Item -ItemType Directory -Path $folder -Force
$path = Join-Path $folder 'WMS365_BOL_ORD-002095_2026-11-02_330PM.pdf'
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($encoded))
Write-Output $path
