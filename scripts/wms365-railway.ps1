param(
    [ValidateSet("status", "deploy", "logs", "health", "version", "release-check")]
    [string] $Action = "status",

    [string] $CandidateCommit = "",

    [int] $Lines = 120
)

$ErrorActionPreference = "Stop"

$ProjectId = "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
$EnvironmentId = "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
$ServiceId = "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0"
$AppUrl = "https://app.wms365.co"

$RailwayCli = (Get-Command railway -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $RailwayCli) {
    $RailwayCli = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'npm\railway.cmd'
}
if (-not (Test-Path -LiteralPath $RailwayCli)) {
    throw "Railway CLI is not installed. Install it with: npm i -g @railway/cli"
}

$env:RAILWAY_CALLER = "wms365-ops-script"
if (-not $env:RAILWAY_AGENT_SESSION) {
    $env:RAILWAY_AGENT_SESSION = "wms365-ops-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

function Invoke-RailwayJson {
    param([string[]] $RailwayArgs)
    & $RailwayCli @RailwayArgs
}

switch ($Action) {
    "status" {
        Invoke-RailwayJson @("status", "--json")
        break
    }
    "deploy" {
        throw "Direct production uploads are disabled. Prove an exact commit in customer-sandbox, publish an immutable release branch whose head is that SHA, then promote only that branch through Railway MCP."
    }
    "release-check" {
        if ($CandidateCommit -notmatch '^[0-9a-fA-F]{40}$') {
            throw "release-check requires -CandidateCommit with the exact 40-character sandbox-proven Git SHA."
        }
        $dirty = & git status --porcelain
        if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Git worktree." }
        if ($dirty) { throw "The release worktree is dirty. Commit or remove every change before promotion." }
        & git cat-file -e "$CandidateCommit^{commit}"
        if ($LASTEXITCODE -ne 0) { throw "Candidate commit $CandidateCommit is not present in this repository." }
        & git fetch --quiet origin codex/production-release
        if ($LASTEXITCODE -ne 0) { throw "Unable to refresh the protected release branch from origin." }
        & git merge-base --is-ancestor $CandidateCommit origin/codex/production-release
        if ($LASTEXITCODE -ne 0) { throw "Candidate commit $CandidateCommit is not on origin/codex/production-release." }
        $normalizedCommit = $CandidateCommit.ToLowerInvariant()
        $releaseBranch = "codex/release-$($normalizedCommit.Substring(0, 8))"
        [pscustomobject]@{
            candidateCommit = $normalizedCommit
            immutableReleaseBranch = $releaseBranch
            worktreeClean = $true
            directUploadDisabled = $true
            promotionMethod = "Railway MCP immutable release branch with exact verified head"
            projectId = $ProjectId
            environmentId = $EnvironmentId
            serviceId = $ServiceId
        } | ConvertTo-Json -Depth 4
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
