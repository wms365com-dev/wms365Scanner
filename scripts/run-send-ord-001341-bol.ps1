param([Parameter(Mandatory=$true)][ValidateSet('upload','preflight','send','cleanup')][string]$Step)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pdfPath = Join-Path $root 'output\pdf\WMS365_BOL_ORD-001341_2026-10-09.pdf'
$pdf = [IO.File]::ReadAllBytes($pdfPath)
$sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pdf)).ToLowerInvariant()
$remotePdf = "/tmp/ord-001341-bol-$sha.pdf"
$railway = Join-Path $root 'outputs\railway-shim\railway.cmd'
$env:RAILWAY_CALLER = 'codex:ord-001341-bol-email'
function Compress64([byte[]]$Bytes) {
  $s=[IO.MemoryStream]::new(); $g=[IO.Compression.GZipStream]::new($s,[IO.Compression.CompressionLevel]::Optimal,$true)
  $g.Write($Bytes,0,$Bytes.Length); $g.Dispose(); $e=[Convert]::ToBase64String($s.ToArray()); $s.Dispose(); return $e
}
switch ($Step) {
  'upload' {
    $encoded = Compress64 $pdf
    $remote = "const fs=require('node:fs'),c=require('node:crypto'),z=require('node:zlib');const p='$remotePdf',b=z.gunzipSync(Buffer.from('$encoded','base64'));if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('PDF hash mismatch');if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(b))throw Error('Remote PDF conflict')}else fs.writeFileSync(p,b,{flag:'wx'});console.log(JSON.stringify({uploaded:true,sha256:'$sha',bytes:b.length}))"
  }
  { $_ -in 'preflight','send' } {
    $source = Compress64 ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'send-ord-001341-bol.js')))
    $apply = if ($Step -eq 'send') { 'true' } else { 'false' }
    $remote = "const fs=require('node:fs'),c=require('node:crypto'),M=require('node:module'),p=require('node:path'),z=require('node:zlib');const b=fs.readFileSync('$remotePdf');if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('Remote PDF hash mismatch');const f=p.join(process.cwd(),'scripts','send-ord-001341-bol.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$source','base64')).toString(),f);m.exports.main(b.toString('base64'),'$sha',$apply).catch(e=>{console.error(e.stack||e.message||e);process.exitCode=1})"
  }
  'cleanup' {
    $remote = "const fs=require('node:fs'),c=require('node:crypto');const p='$remotePdf';if(fs.existsSync(p)){const b=fs.readFileSync(p);if(c.createHash('sha256').update(b).digest('hex')!=='$sha')throw Error('Remote PDF hash mismatch');fs.unlinkSync(p)}console.log(JSON.stringify({removed:true}))"
  }
}
& $railway ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw "ORD-001341 BOL email step failed: $Step" }
