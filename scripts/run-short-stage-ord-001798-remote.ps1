param([switch]$Apply)
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'short-stage-ord-001798.js'))
$bytes=[Text.Encoding]::UTF8.GetBytes($source)
$stream=[IO.MemoryStream]::new()
$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionLevel]::Optimal,$true)
$gzip.Write($bytes,0,$bytes.Length)
$gzip.Dispose()
$encoded=[Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$argsText=if($Apply){"['--apply']"}else{'[]'}
$remote="const M=require('node:module'),p=require('node:path'),z=require('node:zlib');process.argv.push(...$argsText);const f=p.join(process.cwd(),'scripts','short-stage-ord-001798.js');const m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));m._compile(z.gunzipSync(Buffer.from('$encoded','base64')).toString(),f);"
if($Apply){$remote="process.env.APPROVE_ORD_001798_SHORT_STAGE='SKU143_STAGE_44_SHORT_16';$remote"}
& npx --yes '@railway/cli' ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 -- node -e $remote
if($LASTEXITCODE-ne 0){throw 'Remote ORD-001798 workflow failed.'}
