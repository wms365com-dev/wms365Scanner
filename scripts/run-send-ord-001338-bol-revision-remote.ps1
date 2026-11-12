param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('upload', 'preflight', 'send', 'verify', 'cleanup')]
    [string] $Step
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pdfPath = Join-Path $root 'output\pdf\WMS365_BOL_ORD-001338_2026-09-29_REV2.pdf'
$pdf = [IO.File]::ReadAllBytes($pdfPath)
$sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pdf)).ToLowerInvariant()
$remotePdf = "/tmp/ord-001338-bol-$sha.pdf"
$railway = Join-Path $root 'outputs\railway-shim\railway.cmd'
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ord-001338-bol-batch-correction-20260929'

switch ($Step) {
    'upload' {
        $encodedPdf = [Convert]::ToBase64String($pdf)
        $remote = "const fs=require('node:fs'),c=require('node:crypto');const p='$remotePdf',b=Buffer.from('$encodedPdf','base64');if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('PDF hash mismatch');fs.writeFileSync(p,b,{flag:'wx'});console.log(JSON.stringify({uploaded:true,sha256:'$sha',bytes:b.length}))"
    }
    { $_ -in 'preflight', 'send' } {
        $source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'send-ord-001338-bol-dhruv.js'))
        $stream = [IO.MemoryStream]::new()
        $gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionLevel]::Optimal, $true)
        $gzip.Write($source, 0, $source.Length)
        $gzip.Dispose()
        $encodedSource = [Convert]::ToBase64String($stream.ToArray())
        $stream.Dispose()
        $applyFlag = if ($Step -eq 'send') { "process.argv.push('--apply');" } else { '' }
        $remote = "const fs=require('node:fs'),c=require('node:crypto'),M=require('node:module'),p=require('node:path'),z=require('node:zlib');const b=fs.readFileSync('$remotePdf');if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('Remote PDF hash mismatch');process.argv.push('--revision-2');$applyFlag`const f=p.join(process.cwd(),'scripts','send-ord-001338-bol-dhruv.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encodedSource','base64')).toString(),f);m.exports.main(b.toString('base64'),'$sha').catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
    }
    'verify' {
        $remote = @'
const pg=require('pg'),c=require('node:crypto');
(async()=>{const db=new pg.Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL,ssl:false});
await db.connect();try{
const q=await db.query('select o.status,o.shipped_at,d.id as document_id,d.file_data,e.status as email_status,e.message_id,e.bcc_addresses from portal_orders o join portal_order_documents d on d.order_id=o.id and d.file_name=$1 join email_delivery_log e on e.delivery_key=$2 where o.order_code=$3',['WMS365_BOL_ORD-001338_2026-09-29_REV2.pdf','owner-ord-001338-bol-dhruv-20260929-v2','ORD-001338']);
if(q.rowCount!==1)throw Error('Missing or duplicated revision record');
const x=q.rows[0],h=c.createHash('sha256').update(x.file_data).digest('hex');
if(x.status!=='STAGED'||x.shipped_at||x.email_status!=='SENT'||!x.message_id||h!=='__SHA__'||JSON.stringify(x.bcc_addresses)!==JSON.stringify(['d.jain@emotrans-canada.com']))throw Error('Revision verification mismatch');
console.log(JSON.stringify({order:'ORD-001338',status:x.status,emailStatus:x.email_status,documentId:x.document_id,pdfSha256:h,messageId:x.message_id,bccCount:x.bcc_addresses.length}));
}finally{await db.end()}})().catch(e=>{console.error(e.message);process.exitCode=1})
'@.Replace('__SHA__', $sha)
    }
    'cleanup' {
        $remote = "const fs=require('node:fs'),c=require('node:crypto');const p='$remotePdf';if(fs.existsSync(p)){const b=fs.readFileSync(p);if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('Remote PDF hash mismatch');fs.unlinkSync(p)}console.log(JSON.stringify({removed:true}))"
    }
}

$remote = $remote -replace '\r?\n', ' '
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw "BOL revision remote step '$Step' failed" }
