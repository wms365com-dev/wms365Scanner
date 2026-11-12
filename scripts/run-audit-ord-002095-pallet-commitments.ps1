$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Get-Content -Raw (Join-Path $PSScriptRoot "audit-ord-002095-pallet-commitments.js")
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($source))
$remote = "const z=require('node:zlib');const s=Buffer.from(process.env.CODEX_SCRIPT_B64,'base64').toString('utf8');const m=new module.constructor('/app/scripts/audit-ord-002095-pallet-commitments.js');m.filename='/app/scripts/audit-ord-002095-pallet-commitments.js';m.paths=module.paths;m._compile(s,m.filename);"
$env:CODEX_SCRIPT_B64 = $encoded
try {
  railway run --service wms365Scanner --environment production node -e $remote
  if ($LASTEXITCODE -ne 0) { throw "ORD-002095 pallet audit failed" }
} finally {
  Remove-Item Env:CODEX_SCRIPT_B64 -ErrorAction SilentlyContinue
}
