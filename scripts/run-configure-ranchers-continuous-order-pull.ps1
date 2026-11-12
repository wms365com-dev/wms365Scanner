param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'configure-ranchers-continuous-order-pull.js'
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($file)))
$arguments = if ($Apply) { "['--apply']" } else { '[]' }
$remote = "process.argv.push(...$arguments);eval(Buffer.from('$encoded','base64').toString())"
$env:RAILWAY_CALLER = 'skill:use-railway@1.2.3'
$env:RAILWAY_AGENT_SESSION = 'ranchers-continuous-sync-20261025'
& npx --yes '@railway/cli@latest' ssh --project 3f4e7e7e-7eda-4275-8dd0-2c1c3f869698 --service 2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0 --environment e1f5b77e-b935-4f41-9cc5-fccb28edbc57 -- node -e $remote
if ($LASTEXITCODE -ne 0) { throw 'Ranchers continuous schedule configuration failed.' }
