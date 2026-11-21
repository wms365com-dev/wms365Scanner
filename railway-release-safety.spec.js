const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const helper = fs.readFileSync(path.join(root, "scripts", "wms365-railway.ps1"), "utf8");
const policy = fs.readFileSync(path.join(root, "docs", "WMS365_STAGING_RELEASE_POLICY.md"), "utf8");
const operations = fs.readFileSync(path.join(root, "docs", "WMS365_RAILWAY_OPERATIONS.md"), "utf8");

test("production helper cannot upload a local worktree", () => {
    const deployBlock = helper.match(/"deploy"\s*\{([\s\S]*?)\n\s*\}/)?.[1] || "";
    assert.match(deployBlock, /Direct production uploads are disabled/);
    assert.doesNotMatch(deployBlock, /"up"|railway up|Invoke-RailwayJson/);
});

test("release preflight requires an exact commit and clean worktree", () => {
    assert.match(helper, /CandidateCommit -notmatch '\^\[0-9a-fA-F\]\{40\}\$'/);
    assert.match(helper, /git status --porcelain/);
    assert.match(helper, /git cat-file -e/);
    assert.match(helper, /git fetch --quiet origin codex\/production-release/);
    assert.match(helper, /git merge-base --is-ancestor/);
    assert.match(helper, /immutableReleaseBranch = \$releaseBranch/);
    assert.match(helper, /promotionMethod = "Railway MCP immutable release branch with exact verified head"/);
});

test("operations guidance permits only immutable exact-commit promotion", () => {
    assert.match(operations, /release-check -CandidateCommit/);
    assert.match(operations, /-ExecutionPolicy Bypass -File/);
    assert.match(operations, /legacy `deploy` action now fails closed/);
    assert.match(operations, /immutable release branch/);
    assert.match(operations, /same commit SHA/);
    assert.doesNotMatch(operations, /wms365-railway\.ps1 deploy -Message/);
});

test("transport retry policy cannot excuse an executed test failure", () => {
    assert.match(policy, /before the requested command starts/);
    assert.match(policy, /up to three times/);
    assert.match(policy, /Promotion remains blocked until every required command completes successfully/);
    assert.match(policy, /starts and exits nonzero[\s\S]*real failed gate/);
    assert.match(policy, /immutable release branch/);
});
