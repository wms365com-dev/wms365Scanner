# HEALTEA WMS365 API

This API is intentionally scoped to the `HEALTEA` company only. It is for trusted service-to-service use by the shipping/label project.

## Authentication

Set this production environment variable in WMS365:

```text
HEALTEA_API_TOKEN=<long random secret>
```

Every request must send:

```http
Authorization: Bearer <HEALTEA_API_TOKEN>
Content-Type: application/json
```

Do not share this token with browser users.

## Endpoints

Base URL:

```text
https://app.wms365.co/api/healtea/v1
```

### Health

```http
GET /health
```

Returns API/database readiness for the HEALTEA API.

### List Orders

```http
GET /orders?status=open&limit=50
```

`status` options:

- `open`: draft, released, picked, staged
- `all`
- `draft`
- `released`
- `picked`
- `staged`
- `shipped`
- `cancelled`

### Get One Order

```http
GET /orders/ORD-000330
```

Returns order header, ship-to, shipment status, lines, pick locations, documents, and timestamps.

### Record Label Request

```http
POST /orders/ORD-000330/label-request
```

Payload:

```json
{
  "carrier": "UPS",
  "service": "Ground",
  "idempotencyKey": "label-ORD-000330-20260624",
  "note": "Requested by external label project"
}
```

This records an audited WMS activity marker. It does not buy a carrier label by itself.

### Mark Shipped

```http
POST /orders/ORD-000330/ship
```

Payload:

```json
{
  "shipmentMethod": "PARCEL",
  "carrier": "UPS",
  "trackingNumber": "1Z9999999999999999",
  "shipDate": "2026-06-24",
  "note": "Closed by external label project"
}
```

If `shippedLines` is omitted, WMS365 closes the full order quantity for every line. To send explicit line quantities:

```json
{
  "shipmentMethod": "PARCEL",
  "carrier": "UPS",
  "trackingNumber": "1Z9999999999999999",
  "shippedLines": [
    { "sku": "20628693486136", "shippedQuantity": 2 }
  ]
}
```

The endpoint uses the same WMS365 shipped-closeout logic as the warehouse UI, including inventory deduction, audit trail, shipment email scheduling, and Shopify confirmation flow where available.

For speed, the endpoint can advance a `RELEASED` order through `PICKED` and `STAGED` before shipping. It refuses `DRAFT`, `CANCELLED`, or archived orders.
