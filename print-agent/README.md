# WMS365 Print Agent

The WMS365 Print Agent runs on a warehouse PC that can see the local warehouse printers. It connects outbound to WMS365, claims queued print jobs, prints them locally, and reports success/failure back to WMS365.

This avoids exposing warehouse printers to the internet.

## Requirements

- Node.js 18 or newer
- A WMS365 print station token
- The warehouse printer installed on the PC

## Environment

```powershell
$env:WMS365_APP_URL = "https://app.wms365.co"
$env:WMS365_PRINT_STATION_TOKEN = "wms365ps_your_station_token"
node .\wms365-print-agent.js
```

Optional:

```powershell
$env:WMS365_PRINT_POLL_MS = "5000"
$env:WMS365_PRINT_HEARTBEAT_MS = "60000"
```

For a known PDF tool such as SumatraPDF, use a custom command:

```powershell
$env:WMS365_PRINT_COMMAND = '"C:\Program Files\SumatraPDF\SumatraPDF.exe" -print-to {printer} -silent {file}'
```

`{file}` and `{printer}` are replaced by the agent.

## Registration Flow

1. In WMS365, create a print station for the warehouse.
2. Save the one-time station token on the warehouse PC.
3. Register printers against that station:
   - Pick ticket printer
   - Packing slip printer
   - Label printer
4. Start the agent.
5. WMS365 will show heartbeat status through the print setup API.

## API Contract

Agent endpoints:

- `POST /api/print-agent/heartbeat`
- `POST /api/print-agent/jobs/claim`
- `POST /api/print-agent/jobs/:id/complete`

Authentication:

```http
Authorization: Bearer <station token>
```

Admin endpoints:

- `GET /api/admin/print-setup`
- `POST /api/admin/print-stations`
- `POST /api/admin/warehouse-printers`
- `POST /api/admin/portal-orders/:id/print-jobs`

## Print Count Control

WMS365 records a document print count only after the agent reports the job as successfully printed.
