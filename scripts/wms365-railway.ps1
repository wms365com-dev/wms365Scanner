param(
    [ValidateSet("status", "deploy", "logs", "health", "version")]
    [string] $Action = "status",

    [string] $Message = "Deploy WMS365 update",

    [int] $Lines = 120
)

$ErrorActionPreference = "Stop"

$ProjectId = "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
$EnvironmentId = "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
$ServiceId = "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0"
$AppUrl = "https://app.wms365.co"

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    throw "Railway CLI is not installed. Install it with: npm i -g @railway/cli"
}

$env:RAILWAY_CALLER = "wms365-ops-script"
if (-not $env:RAILWAY_AGENT_SESSION) {
    $env:RAILWAY_AGENT_SESSION = "wms365-ops-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

function Invoke-RailwayJson {
    param([string[]] $RailwayArgs)
    & railway @RailwayArgs
}

switch ($Action) {
    "status" {
        Invoke-RailwayJson @("status", "--json")
        break
    }
    "deploy" {
        Invoke-RailwayJson @(
            "up",
            "--detach",
            "--project", $ProjectId,
            "--environment", $EnvironmentId,
            "--service", $ServiceId,
            "-m", $Message
        )
        & curl.exe -fsS "$AppUrl/api/health"
        & curl.exe -fsS "$AppUrl/api/version"
        break
    }
    "logs" {
        Invoke-RailwayJson @(
            "logs",
            "--environment", $EnvironmentId,
            "--service", $ServiceId,
            "--lines", [string] $Lines
        )
        break
    }
    "health" {
        & curl.exe -fsS "$AppUrl/api/health"
        break
    }
    "version" {
        & curl.exe -fsS "$AppUrl/api/version"
        break
    }
}
