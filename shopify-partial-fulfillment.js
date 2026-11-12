"use strict";

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function buildPartialFulfillmentLines(order, fulfillmentOrders, shopifyLines, mappings = []) {
    const confirmations = new Map((order.shipmentLines || []).map((line) => [
        String(line.orderLineId), Number(line.shippedQuantity)
    ]));
    const wanted = new Map();
    for (const line of order.lines || []) {
        const sku = String(line.sku || "").trim();
        const shipped = confirmations.get(String(line.id));
        if (!sku || !Number.isSafeInteger(shipped) || shipped < 0 || shipped > positiveInteger(line.quantity)) {
            throw new Error(`Partial Shopify fulfillment requires a confirmed, valid shipped quantity for ${sku || "every SKU"}.`);
        }
        if (shipped > 0) wanted.set(sku, (wanted.get(sku) || 0) + shipped);
    }
    if (!wanted.size) throw new Error("Partial Shopify fulfillment has no shipped units.");

    const mappingByExternal = new Map(mappings.map((row) => [String(row.external_sku || "").trim(), row]));
    const byLocalSku = new Map();
    for (const line of shopifyLines || []) {
        const externalSku = String(line.sku || "").trim();
        const mapping = mappingByExternal.get(externalSku);
        const localSku = String(mapping?.local_sku || externalSku).trim();
        if (!wanted.has(localSku)) continue;
        const multiplier = positiveInteger(mapping?.local_quantity_multiplier || 1);
        if (!multiplier || !positiveInteger(line.id) || byLocalSku.has(localSku)) {
            throw new Error(`Shopify line mapping is missing or ambiguous for ${localSku}.`);
        }
        byLocalSku.set(localSku, { lineId: positiveInteger(line.id), multiplier });
    }

    const remaining = new Map();
    for (const [sku, localQuantity] of wanted) {
        const mapped = byLocalSku.get(sku);
        if (!mapped || localQuantity % mapped.multiplier !== 0) {
            throw new Error(`Shopify quantity mapping is missing or indivisible for ${sku}.`);
        }
        remaining.set(mapped.lineId, localQuantity / mapped.multiplier);
    }

    const pairs = [];
    for (const fulfillmentOrder of fulfillmentOrders || []) {
        if (String(fulfillmentOrder.status || "").toUpperCase() !== "OPEN") continue;
        const selected = [];
        for (const line of fulfillmentOrder.line_items || []) {
            const needed = remaining.get(positiveInteger(line.line_item_id)) || 0;
            if (!needed) continue;
            const available = positiveInteger(line.fulfillable_quantity ?? line.quantity);
            const quantity = Math.min(needed, available);
            if (!quantity || !positiveInteger(line.id)) continue;
            selected.push({ id: positiveInteger(line.id), quantity });
            remaining.set(positiveInteger(line.line_item_id), needed - quantity);
        }
        if (selected.length) pairs.push({
            fulfillment_order_id: positiveInteger(fulfillmentOrder.id),
            fulfillment_order_line_items: selected
        });
    }
    if (!pairs.length || pairs.some((pair) => !pair.fulfillment_order_id)
        || [...remaining.values()].some((quantity) => quantity !== 0)) {
        throw new Error("Shopify does not have enough open quantity for the confirmed WMS shipment.");
    }
    return pairs;
}

module.exports = { buildPartialFulfillmentLines };
