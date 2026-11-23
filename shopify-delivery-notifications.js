"use strict";

const NOTIFICATION_MODES = Object.freeze(["SHOPIFY", "WMS", "BOTH"]);
const DEFAULT_ENABLED_EVENTS = Object.freeze([
    "SHIPPED", "EXCEPTION", "OUT_FOR_DELIVERY", "DELIVERY_ATTEMPTED", "DELIVERED"
]);
const SUPPORTED_EVENTS = Object.freeze([...DEFAULT_ENABLED_EVENTS, "IN_TRANSIT", "PICKED_UP"]);
const SHOPIFY_SEND_STATES = Object.freeze(["UNKNOWN", "REQUESTED", "SENT", "NOT_SENT"]);
const SHOPIFY_NATIVE_EVENTS = Object.freeze(["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);

function nativeConfigurationState(store, status, eventAt, shopifySendState) {
    const review = store.shopifyNativeEvents?.[status];
    if (!review || !["ENABLED", "DISABLED"].includes(review.state)
        || cleanText(review.companyId) !== cleanText(store.companyId)
        || cleanText(review.storeId) !== cleanText(store.id)
        || !normalizeDate(review.reviewedAt) || !cleanText(review.reviewedBy) || !cleanText(review.evidenceRef)) return "UNKNOWN";
    if (review.state === "DISABLED" && shopifySendState !== "NOT_SENT") {
        const occurredAt = normalizeDate(eventAt);
        // A later disable review cannot establish that Shopify was disabled for an older event.
        if (!occurredAt || Date.parse(review.reviewedAt) > Date.parse(occurredAt)) return "UNKNOWN";
    }
    return review.state;
}

function cleanText(value) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
}

function safeUrl(value) {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return "";
    try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return "";
        return url.href;
    } catch {
        return "";
    }
}

function normalizeEvent(value) {
    return cleanText(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().replace(/[ -]+/g, "_");
}

function normalizeDate(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value !== "string" && !(value instanceof Date)) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizePolicy(store = {}) {
    const mode = store.notificationMode === undefined ? "SHOPIFY" : cleanText(store.notificationMode).toUpperCase();
    if (!NOTIFICATION_MODES.includes(mode)) throw new TypeError("Invalid notificationMode");
    const events = store.enabledEvents === undefined ? DEFAULT_ENABLED_EVENTS : store.enabledEvents;
    if (!Array.isArray(events)) throw new TypeError("enabledEvents must be an array");
    const enabledEvents = [...new Set(events.map(normalizeEvent))];
    if (enabledEvents.some((event) => !SUPPORTED_EVENTS.includes(event))) throw new TypeError("Unsupported notification event");
    return { mode, enabledEvents, smsEnabled: store.smsEnabled === true };
}

function requiredId(value, name) {
    if (!["string", "number"].includes(typeof value) || !cleanText(value)) throw new TypeError(`${name} is required`);
    return cleanText(value);
}

function notificationScope(store, shipment) {
    const companyId = requiredId(store.companyId, "store.companyId");
    const storeId = requiredId(store.id, "store.id");
    if (requiredId(shipment.companyId, "shipment.companyId") !== companyId
        || requiredId(shipment.storeId, "shipment.storeId") !== storeId) {
        throw new TypeError("Shipment does not belong to this company/store");
    }
    return {
        companyId, storeId,
        warehouseId: requiredId(shipment.warehouseId, "shipment.warehouseId"),
        orderId: requiredId(shipment.orderId, "shipment.orderId"),
        shipmentId: requiredId(shipment.id, "shipment.id")
    };
}

// Scan IDs, timestamps and descriptions are deliberately excluded from deduplication.
// Transit location/ETA changes are meaningful; milestone events are once per parcel.
function buildNotificationKey({ store, shipment, event, channel = "EMAIL" }) {
    if (!["EMAIL", "SMS"].includes(channel)) throw new TypeError("Invalid notification channel");
    const scope = notificationScope(store, shipment);
    const status = normalizeEvent(event.status);
    if (!SUPPORTED_EVENTS.includes(status)) throw new TypeError("Unsupported notification event");
    return JSON.stringify([
        "delivery-v1", scope.companyId, scope.storeId, scope.warehouseId, scope.orderId,
        scope.shipmentId, cleanText(shipment.trackingNumber), "WMS", channel, status,
        status === "IN_TRANSIT" ? cleanText(event.location).toUpperCase() : "",
        status === "IN_TRANSIT" ? normalizeDate(event.estimatedDelivery) : ""
    ]);
}

function buildContent(store, shipment, event) {
    return {
        orderNumber: cleanText(shipment.orderNumber),
        carrier: cleanText(shipment.carrier),
        trackingNumber: cleanText(shipment.trackingNumber),
        trackingUrl: safeUrl(shipment.trackingUrl),
        status: normalizeEvent(event.status),
        eventAt: normalizeDate(event.eventAt),
        scan: cleanText(event.description),
        location: cleanText(event.location),
        estimatedDelivery: normalizeDate(event.estimatedDelivery),
        branding: {
            name: cleanText(store.branding?.name) || "WMS365",
            logoUrl: safeUrl(store.branding?.logoUrl),
            websiteUrl: safeUrl(store.branding?.websiteUrl)
        }
    };
}

function renderNotification(content) {
    const branding = content.branding || {};
    const fields = [
        ["Order", content.orderNumber], ["Status", content.status], ["Carrier", content.carrier],
        ["Tracking number", content.trackingNumber], ["Time", content.eventAt],
        ["Scan", content.scan], ["Location", content.location], ["ETA", content.estimatedDelivery]
    ].map(([label, value]) => [label, cleanText(value) || "Not available"]);
    const trackingUrl = safeUrl(content.trackingUrl);
    const logoUrl = safeUrl(branding.logoUrl);
    const websiteUrl = safeUrl(branding.websiteUrl);
    const name = cleanText(branding.name) || "WMS365";
    const text = [name, ...fields.map(([label, value]) => `${label}: ${value}`),
        ...(trackingUrl ? [`Track: ${trackingUrl}`] : []),
        ...(websiteUrl ? [websiteUrl] : [])].join("\n");
    const html = [
        `<h1>${escapeHtml(name)}</h1>`,
        ...(logoUrl ? [`<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(name)}">`] : []),
        ...fields.map(([label, value]) => `<p><strong>${label}:</strong> ${escapeHtml(value)}</p>`),
        ...(trackingUrl ? [`<p><a href="${escapeHtml(trackingUrl)}" rel="noopener noreferrer">Track shipment</a></p>`] : []),
        ...(websiteUrl ? [`<p><a href="${escapeHtml(websiteUrl)}" rel="noopener noreferrer">${escapeHtml(name)}</a></p>`] : [])
    ].join("\n");
    return {
        subject: `${name}: Order ${cleanText(content.orderNumber)} - ${cleanText(content.status)}`,
        text, html
    };
}

/**
 * Pure post-Shopify policy. store holds this store's configuration; shipment must
 * carry matching ownership. shopifySendState is evidence for this parcel/event,
 * not notifyCustomer, fulfillment success, a timeout or an assumed missing email.
 * BOTH leaves Shopify enabled and independently plans WMS delivery. This module
 * never sends via either provider. Callers must authorize scope, atomically reserve
 * keys and persist successful deliveries; sentKeys contains only confirmed sends.
 * A deferred decision must not be recorded as sent.
 * Official references reviewed 2026-09-17:
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
 * https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications
 * https://docs.ongoingwarehouse.com/manuals/customer-manual
 * Notification preferences are not send receipts; portal tracking is not email evidence.
 */
function evaluateDeliveryNotification({
    store = {}, shipment = {}, event = {}, recipient = {}, shopifySendState = "UNKNOWN", sentKeys = []
} = {}) {
    const policy = normalizePolicy(store);
    const scope = notificationScope(store, shipment);
    if (!Array.isArray(sentKeys) && !(sentKeys instanceof Set)) throw new TypeError("sentKeys must be an array or Set");
    const sent = new Set(sentKeys);
    const status = normalizeEvent(event.status);
    // Only these explicit evidence states are recognized; booleans/assumptions fail closed.
    const state = SHOPIFY_SEND_STATES.includes(shopifySendState) ? shopifySendState : "UNKNOWN";
    const result = {
        mode: policy.mode, scope,
        shopify: { enabled: status === "SHIPPED" || policy.mode !== "WMS",
            initialNotifyCustomer: status === "SHIPPED", sendState: state },
        decision: "SUPPRESS", reason: "EVENT_DISABLED", notifications: []
    };
    if (!policy.enabledEvents.includes(status)) return result;
    if (policy.mode !== "BOTH" && state === "REQUESTED" && SHOPIFY_NATIVE_EVENTS.includes(status)) {
        return { ...result, reason: "SHOPIFY_REQUESTED" };
    }
    if (policy.mode !== "BOTH" && state === "SENT") return { ...result, reason: "SHOPIFY_SENT" };
    if (policy.mode === "SHOPIFY" && state !== "NOT_SENT") {
        return { ...result, decision: state === "SENT" ? "SUPPRESS" : "DEFER",
            reason: state === "SENT" ? "SHOPIFY_SENT" : "SHOPIFY_SEND_UNKNOWN" };
    }
    if (policy.mode === "WMS" && SHOPIFY_NATIVE_EVENTS.includes(status)
        && nativeConfigurationState(store, status, event.eventAt, state) !== "DISABLED") {
        return { ...result, decision: "DEFER", reason: "SHOPIFY_NATIVE_NOT_VERIFIED_DISABLED" };
    }
    const channels = [];
    const email = cleanText(recipient.email);
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) channels.push(["EMAIL", email]);
    const phone = cleanText(recipient.phone);
    if (policy.smsEnabled && recipient.smsConsent === true && /^\+[1-9]\d{7,14}$/.test(phone)) channels.push(["SMS", phone]);
    const content = buildContent(store, shipment, event);
    const rendered = renderNotification(content);
    for (const [channel, to] of channels) {
        const key = buildNotificationKey({ store, shipment, event, channel });
        if (!sent.has(key)) result.notifications.push({ provider: "WMS", channel, to, key, content, ...rendered });
    }
    if (result.notifications.length) {
        result.decision = "SEND";
        result.reason = policy.mode === "SHOPIFY" ? "CONFIRMED_SHOPIFY_NOT_SENT" : "WMS_ENABLED";
    } else {
        result.reason = channels.length ? "DUPLICATE" : "NO_ELIGIBLE_RECIPIENT";
    }
    return result;
}

module.exports = {
    NOTIFICATION_MODES, DEFAULT_ENABLED_EVENTS, SUPPORTED_EVENTS, SHOPIFY_SEND_STATES, SHOPIFY_NATIVE_EVENTS,
    normalizePolicy, buildNotificationKey, evaluateDeliveryNotification, renderNotification,
    escapeHtml, safeUrl
};
