param(
    [Parameter(Mandatory = $true)][string]$WorkbookPath,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$python = 'C:\Users\T470\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $WorkbookPath)) { throw "Workbook not found: $WorkbookPath" }

$pythonCode = @'
import base64
import hashlib
import json
import pathlib
import re
import sys
import gzip
import openpyxl

path = pathlib.Path(sys.argv[1])
file_bytes = path.read_bytes()
file_sha = hashlib.sha256(file_bytes).hexdigest()
workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
sheet = workbook["Sheet 1"]
orders = []

def parse_city_line(value, source_row):
    parts = [part.strip() for part in str(value or "").split(",")]
    if len(parts) < 2 or not parts[0]:
        raise ValueError(f"Source row {source_row}: city/province/postal value is invalid.")
    city = parts[0]
    compact = re.sub(r"[^A-Z0-9]", "", "".join(parts[1:]).upper())
    if len(compact) < 8:
        raise ValueError(f"Source row {source_row}: province/postal value is invalid.")
    state, postal = compact[:-6], compact[-6:]
    chars = list(postal)
    for index in (1, 3, 5):
        chars[index] = {"O": "0", "I": "1", "L": "1"}.get(chars[index], chars[index])
    postal = "".join(chars)
    if not re.fullmatch(r"[A-Z]\d[A-Z]\d[A-Z]\d", postal) or not re.fullmatch(r"[A-Z]{2}", state):
        raise ValueError(f"Source row {source_row}: province/postal value is invalid after normalization.")
    return city, state, f"{postal[:3]} {postal[3:]}"

for source_row, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
    name, phone, email, address, city_line, units, source_sku = row
    if not name:
        continue
    quantity_match = re.match(r"\s*(\d+)\s*x\s*", str(units or ""), re.I)
    quantity = int(quantity_match.group(1)) if quantity_match else 1
    city, state, postal = parse_city_line(city_line, source_row)
    sku = "TP-WW-6PK-UPC" if "6 PACK" in str(units or "").upper() else str(source_sku or "").strip().upper()
    orders.append({
        "sourceRow": source_row,
        "reference": f"WF-CONS-20261007-{source_row - 1:02d}-{file_sha[:8].upper()}",
        "name": str(name).strip(),
        "phone": str(phone or "").strip(),
        "email": str(email or "").strip(),
        "address1": str(address or "").strip(),
        "address2": "",
        "city": city,
        "state": state,
        "postalCode": postal,
        "country": "CA",
        "requestedShipDate": "2026-10-07",
        "sku": sku,
        "quantity": quantity,
    })

orders_json = json.dumps(orders, separators=(",", ":"), ensure_ascii=False)
payload = {
    "sourceFileName": path.name,
    "sourceFileSha256": file_sha,
    "ordersSha256": hashlib.sha256(orders_json.encode("utf-8")).hexdigest(),
    "orders": orders,
}
payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
print(base64.b64encode(gzip.compress(payload_json, compresslevel=9)).decode("ascii"))
'@

$payloadBase64 = (& $python -c $pythonCode $WorkbookPath | Select-Object -Last 1).Trim()
if (-not $payloadBase64) { throw 'Workbook payload generation failed.' }
$runner = Join-Path $PSScriptRoot 'run-import-wellforia-consumer-orders-remote.ps1'
if ($Apply) {
    & $runner -PayloadBase64 $payloadBase64 -Apply
} else {
    & $runner -PayloadBase64 $payloadBase64
}
if ($LASTEXITCODE -ne 0) { throw 'Wellforia consumer workbook import failed.' }
