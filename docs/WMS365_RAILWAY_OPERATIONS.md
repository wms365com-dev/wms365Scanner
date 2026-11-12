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
.\scripts\wms365-railway.ps1 status
.\scripts\wms365-railway.ps1 version
.\scripts\wms365-railway.ps1 health
.\scripts\wms365-railway.ps1 logs -Lines 200
.\scripts\wms365-railway.ps1 deploy -Message "Deploy WMS365 update"
```

The script always passes the pinned production project, environment, and service IDs to Railway so it does not depend on selecting the correct project in the dashboard.
For `status`, Railway CLI uses the local linked project context; this checkout has been linked to WMS365 Live production.

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
.\scripts\wms365-railway.ps1 status
```
