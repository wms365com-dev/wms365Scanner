param([switch]$Apply)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$sourcePath=Join-Path $PSScriptRoot 'prepare-ord-001902-bol.js'
$bytes=[Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($sourcePath))
$stream=[IO.MemoryStream]::new();$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true)
$gzip.Write($bytes,0,$bytes.Length);$gzip.Dispose();$encoded=[Convert]::ToBase64String($stream.ToArray());$stream.Dispose()
$applyArg=if($Apply){"process.argv.push('--apply');"}else{''}
$remote="const M=require('node:module'),p=require('node:path'),z=require('node:zlib');$applyArg const f=p.join(process.cwd(),'scripts','prepare-ord-001902-bol.js'),m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);m.exports.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});"
$env:RAILWAY_CALLER='skill:use-railway@1.2.3';$env:RAILWAY_AGENT_SESSION='ord-001902-bol-20261104'
$lines=& (Join-Path $repo 'outputs\railway-shim\railway.cmd') ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if($LASTEXITCODE-ne 0){$lines|Write-Output;throw 'Remote ORD-001902 BOL preparation failed.'}
$jsonLine=$lines|Where-Object{$_ -match '^\{"mode"'}|Select-Object -Last 1
if(-not $jsonLine){$lines|Write-Output;throw 'ORD-001902 BOL response was missing.'}
$result=$jsonLine|ConvertFrom-Json
if($Apply){
  $outDir=Join-Path $repo 'output\pdf';New-Item -ItemType Directory -Force -Path $outDir|Out-Null
  $outPath=Join-Path $outDir $result.fileName
  [IO.File]::WriteAllBytes($outPath,[Convert]::FromBase64String($result.pdfBase64))
  $result.PSObject.Properties.Remove('pdfBase64');$result|Add-Member -NotePropertyName outputPath -NotePropertyValue $outPath
}
$result|ConvertTo-Json -Depth 8
