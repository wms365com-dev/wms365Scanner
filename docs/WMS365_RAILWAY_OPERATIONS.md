# WMS365 Railway Operations

Production Railway service:

- Project: `WMS365 Live`
- Project ID: `3f4e7e7e-7eda-4275-8dd0-2c1c3f869698`
- Environment: `production`
- Environment ID: `e1f5b77e-b935-4f41-9cc5-fccb28edbc57`
- Service: `wms365Scanner`
- Service ID: `2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0`
- Live URL: `https://app.wms365.co`

Use the helper script from the repo root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 version
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 health
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 logs -Lines 200
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 release-check -CandidateCommit <sandbox-proven-40-character-sha>
```

The script always passes the pinned production project, environment, and service IDs to Railway so it does not depend on selecting the correct project in the dashboard. Its legacy `deploy` action now fails closed: production must never be uploaded from a local directory with `railway up`.

After `release-check` succeeds and all sandbox evidence is complete, create the reported immutable release branch with its head exactly at the candidate SHA (for example, `git push origin <sha>:refs/heads/codex/release-<short-sha>`). Verify the remote branch head, then stage that branch and exact SHA as the production service source through Railway MCP. Railway has previously acknowledged a staged `commitSha` while resolving a mutable branch's newer head, so a commit pin on a moving branch is not sufficient evidence. Accept the deploy only after reviewing that single staged source change. Re-read production deployment metadata and require both the immutable branch and the same commit SHA before health verification.
For `status`, Railway CLI uses the local linked project context; this checkout has been linked to WMS365 Live.

Codex/Railway setup on this machine:

- Railway CLI is installed and authenticated.
- Railway remote MCP is configured for Codex through `railway setup agent -y --remote`.
- If Railway MCP does not appear in a new Codex session, restart Codex so it reloads `C:\Users\T470\.codex\config.toml`.

If auth expires again, run:

```powershell
railway login
```

Then verify:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\wms365-railway.ps1 status
```
