"use strict";

const { Client } = require("pg");
const { afterShipCarrierSlug, normalizeAfterShipTracking } = require("../carrier-tracking");

const ACCOUNT = "WELLFORIA HEALTH INC";
const START = "2026-10-01";
const END = "2026-11-01";
const API_URL = String(process.env.AFTERSHIP_TRACKING_API_URL || "https://api.aftership.com/tracking/2026-07").replace(/\/+$/, "");
const PHYSICAL = new Set(["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "AVAILABLE_FOR_PICKUP", "DELIVERED", "DELIVERY_ATTEMPTED", "EXCEPTION", "RETURNED"]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function validTracking(carrier, tracking) {
  const value = String(tracking || "").trim().toUpperCase();
  const key = String(carrier || "").trim().toUpperCase();
  if (key === "PUROLATOR") return /^\d{12}$/.test(value);
  if (key === "UPS") return /^1Z[0-9A-Z]{16}$/.test(value);
  if (key === "CANPAR") return /^D\d{18,24}$/.test(value);
  if (key === "FEDEX") return /^\d{12,15}$/.test(value);
  return false;
}

async function poll(carrier, tracking) {
  const key = process.env.AFTERSHIP_TRACKING_API_KEY;
  if (!key) throw new Error("Live carrier tracking is not configured.");
  const slug = afterShipCarrierSlug(carrier);
  if (!slug) return { ok: false, reason: "unsupported-carrier" };
  const headers = { "as-api-key": key, "as-api-version": "2026-07", "Content-Type": "application/json" };
  let response = await fetch(`${API_URL}/trackings?tracking_numbers=${encodeURIComponent(tracking)}&slug=${encodeURIComponent(slug)}&limit=2`, { headers, signal: AbortSignal.timeout(30000) });
  let payload = response.ok ? await response.json() : null;
  const found = Boolean(payload?.data?.tracking || payload?.data?.trackings?.length || payload?.tracking || payload?.trackings?.length);
  if (response.status === 404 || (response.ok && !found)) {
    response = await fetch(`${API_URL}/trackings`, {
      method: "POST", headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ tracking: { slug, tracking_number: tracking } }),
    });
    payload = response.ok ? await response.json() : null;
  }
  if (!response.ok) return { ok: false, reason: `carrier-http-${response.status}`, retryAfter: response.headers.get("retry-after") || "" };
  const normalized = normalizeAfterShipTracking(payload);
  const firstPhysical = normalized.events.find((event) => PHYSICAL.has(event.status) && event.eventAt) || null;
  return {
    ok: true,
    status: normalized.status,
    statusDetail: normalized.statusDetail,
    firstPhysical,
    latestEvent: normalized.events.length ? normalized.events[normalized.events.length - 1] : null,
    eventCount: normalized.events.length,
  };
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    const result = await db.query(
      `select o.id,o.order_code,o.status,o.requested_ship_date::text,o.shipment_method,
              o.shipped_carrier_name carrier,o.shipped_tracking_reference tracking,
              fl.code warehouse_code,
              coalesce((select sum(l.requested_quantity) from portal_order_lines l where l.order_id=o.id),0)::integer requested_quantity,
              coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_id=o.id),0)::integer allocated_quantity,
              exists(select 1 from portal_order_documents d where d.order_id=o.id
                     and (d.document_category='SHIPPING_LABEL' or d.file_name ~* '(shipping[- _]?label|purolator|ups|canpar|fedex)')) has_label
         from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')
          and o.requested_ship_date >= $2::date and o.requested_ship_date < $3::date
          and nullif(trim(o.shipped_tracking_reference),'') is not null
        order by o.requested_ship_date,o.order_code`,
      [ACCOUNT, START, END]
    );
    const output = [];
    for (const order of result.rows) {
      const base = { ...order, fullyAllocated: Number(order.requested_quantity) > 0 && Number(order.requested_quantity) === Number(order.allocated_quantity) };
      if (!order.has_label) {
        output.push({ ...base, carrierEvidence: { ok: false, reason: "no-shipping-label-document" } });
        continue;
      }
      if (!validTracking(order.carrier, order.tracking)) {
        output.push({ ...base, carrierEvidence: { ok: false, reason: "invalid-carrier-tracking-format" } });
        continue;
      }
      try {
        output.push({ ...base, carrierEvidence: await poll(order.carrier, order.tracking) });
      } catch (error) {
        output.push({ ...base, carrierEvidence: { ok: false, reason: String(error.message || error) } });
      }
      await sleep(500);
    }
    console.log(JSON.stringify({ account: ACCOUNT, period: { start: START, end: END }, checked: output.length, orders: output }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
