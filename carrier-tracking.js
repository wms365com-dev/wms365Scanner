const crypto = require("crypto");

const TRACKING_STATUSES = Object.freeze([
    "PENDING",
    "LABEL_CREATED",
    "PICKED_UP",
    "IN_TRANSIT",
    "OUT_FOR_DELIVERY",
    "AVAILABLE_FOR_PICKUP",
    "DELIVERED",
    "DELIVERY_ATTEMPTED",
    "EXCEPTION",
    "RETURNED",
    "CANCELLED",
    "UNKNOWN"
]);

const TERMINAL_TRACKING_STATUSES = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);

const STATUS_ALIASES = Object.freeze({
    PENDING: "PENDING",
    PRE_TRANSIT: "LABEL_CREATED",
    PRETRANSIT: "LABEL_CREATED",
    INFO_RECEIVED: "LABEL_CREATED",
    INFORMATION_RECEIVED: "LABEL_CREATED",
    LABEL_CREATED: "LABEL_CREATED",
    PICKED_UP: "PICKED_UP",
    PICKUP: "PICKED_UP",
    ACCEPTED: "PICKED_UP",
    IN_TRANSIT: "IN_TRANSIT",
    TRANSIT: "IN_TRANSIT",
    DEPARTED: "IN_TRANSIT",
    ARRIVED: "IN_TRANSIT",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
    OUTFORDELIVERY: "OUT_FOR_DELIVERY",
    AVAILABLE_FOR_PICKUP: "AVAILABLE_FOR_PICKUP",
    AVAILABLE_FOR_COLLECTION: "AVAILABLE_FOR_PICKUP",
    DELIVERED: "DELIVERED",
    ATTEMPT_FAIL: "DELIVERY_ATTEMPTED",
    DELIVERY_ATTEMPTED: "DELIVERY_ATTEMPTED",
    FAILED_ATTEMPT: "DELIVERY_ATTEMPTED",
    EXCEPTION: "EXCEPTION",
    FAILURE: "EXCEPTION",
    FAILED: "EXCEPTION",
    ALERT: "EXCEPTION",
    EXPIRED: "EXCEPTION",
    RETURN_TO_SENDER: "RETURNED",
    RETURNED: "RETURNED",
    CANCELLED: "CANCELLED",
    CANCELED: "CANCELLED",
    UNKNOWN: "UNKNOWN"
});

const AFTERSHIP_CARRIER_SLUGS = Object.freeze({
    UPS: "ups",
    PUROLATOR: "purolator",
    CANPAR: "canpar",
    FEDEX: "fedex",
    CANADA_POST: "canada-post",
    DHL: "dhl",
    USPS: "usps",
    LOOMIS: "loomis-express",
    GLS: "gls",
    DAY_ROSS: "dayross",
    ICS_COURIER: "icscourier",
    DRAGONFLY: "intelcom-ca",
    UNIUNI: "uniuni",
    TFORCE_FREIGHT: "tforce-freight",
    XPO: "xpo"
});

function normalizeCode(value) {
    return String(value || "")
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function normalizeTrackingStatus(value) {
    const code = normalizeCode(value);
    return STATUS_ALIASES[code] || (TRACKING_STATUSES.includes(code) ? code : "UNKNOWN");
}

function isTerminalTrackingStatus(value) {
    return TERMINAL_TRACKING_STATUSES.has(normalizeTrackingStatus(value));
}

function normalizeTrackingCarrier(value) {
    const code = normalizeCode(value);
    if (/^UPS(?:_|$)|UNITED_PARCEL/.test(code)) return "UPS";
    if (code.includes("PUROLATOR")) return "PUROLATOR";
    if (code.includes("CANPAR")) return "CANPAR";
    if (code.includes("FEDEX") || code.includes("FED_EX")) return "FEDEX";
    if (code.includes("CANADA_POST") || code.includes("POSTES_CANADA")) return "CANADA_POST";
    if (code.startsWith("DHL")) return "DHL";
    if (code.includes("USPS") || code.includes("US_POSTAL")) return "USPS";
    if (code.includes("LOOMIS")) return "LOOMIS";
    if (code === "GLS" || code.includes("GLS_CANADA") || code.includes("DICOM")) return "GLS";
    if (code.includes("DAY_ROSS") || code.includes("DAYROSS")) return "DAY_ROSS";
    if (code === "ICS" || code.includes("ICS_COURIER")) return "ICS_COURIER";
    if (code.includes("DRAGONFLY") || code.includes("INTELCOM")) return "DRAGONFLY";
    if (code.includes("UNIUNI") || code.includes("UNI_UNI")) return "UNIUNI";
    if (code.includes("TFORCE") || code.includes("T_FORCE")) return "TFORCE_FREIGHT";
    if (code === "XPO" || code.includes("XPO_LOGISTICS")) return "XPO";
    return code || "UNKNOWN";
}

function afterShipCarrierSlug(value) {
    return AFTERSHIP_CARRIER_SLUGS[normalizeTrackingCarrier(value)] || "";
}

function parseEventDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function trackingEventFingerprint(event = {}) {
    const stable = [
        normalizeTrackingStatus(event.status),
        String(event.rawStatusCode || event.raw_status_code || "").trim(),
        parseEventDate(event.eventAt || event.event_at) || "",
        String(event.location || "").trim().toUpperCase(),
        String(event.description || "").trim().toUpperCase()
    ].join("|");
    return crypto.createHash("sha256").update(stable, "utf8").digest("hex");
}

function sanitizeTrackingEvent(event = {}) {
    const normalized = {
        providerEventId: String(event.providerEventId || event.provider_event_id || "").trim().slice(0, 180),
        status: normalizeTrackingStatus(event.status || event.tag || event.checkpoint_status),
        rawStatusCode: String(event.rawStatusCode || event.raw_status_code || event.subtag || event.checkpoint_status || "").trim().slice(0, 120),
        description: String(event.description || event.message || "").trim().replace(/\s+/g, " ").slice(0, 600),
        location: String(event.location || event.city || "").trim().replace(/\s+/g, " ").slice(0, 240),
        eventAt: parseEventDate(event.eventAt || event.event_at || event.checkpoint_time || event.created_at),
        source: normalizeCode(event.source || "PROVIDER").slice(0, 40) || "PROVIDER"
    };
    normalized.eventKey = normalized.providerEventId || trackingEventFingerprint(normalized);
    return normalized;
}

function afterShipLocation(checkpoint = {}) {
    return [checkpoint.city, checkpoint.state, checkpoint.country_region_name || checkpoint.country_name]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(", ");
}

function normalizeAfterShipTracking(payload = {}) {
    const tracking = payload?.msg?.tracking
        || payload?.data?.tracking
        || payload?.data?.trackings?.[0]
        || payload?.tracking
        || payload?.trackings?.[0]
        || payload?.data
        || payload;
    const checkpoints = Array.isArray(tracking?.checkpoints) ? tracking.checkpoints : [];
    const events = checkpoints.map((checkpoint) => sanitizeTrackingEvent({
        providerEventId: checkpoint.id || "",
        status: checkpoint.tag || checkpoint.checkpoint_status,
        rawStatusCode: checkpoint.subtag || checkpoint.checkpoint_status || "",
        description: checkpoint.message || checkpoint.subtag_message || "",
        location: afterShipLocation(checkpoint),
        eventAt: checkpoint.checkpoint_time || checkpoint.created_at,
        source: "AFTERSHIP"
    })).filter((event) => event.eventAt || event.description || event.status !== "UNKNOWN")
        .sort((left, right) => new Date(left.eventAt || 0) - new Date(right.eventAt || 0));
    const latest = events.length ? events[events.length - 1] : null;
    const status = normalizeTrackingStatus(tracking?.tag || tracking?.status || latest?.status);
    return {
        providerTrackerId: String(tracking?.id || "").trim(),
        carrierSlug: String(tracking?.slug || "").trim(),
        status,
        statusDetail: String(tracking?.subtag_message || tracking?.subtag || latest?.description || "").trim().slice(0, 600),
        estimatedDelivery: parseEventDate(tracking?.expected_delivery || tracking?.expected_delivery_date),
        deliveredAt: status === "DELIVERED" ? (latest?.eventAt || parseEventDate(tracking?.updated_at)) : null,
        events
    };
}

function verifyWebhookHmac(rawBody, providedSignature, secret) {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
    const provided = String(providedSignature || "").trim().replace(/^sha256=/i, "");
    if (!provided || !secret) return false;
    const expectedHex = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const expectedBase64 = crypto.createHmac("sha256", secret).update(body).digest("base64");
    return [expectedHex, expectedBase64].some((candidate) => {
        const left = Buffer.from(candidate);
        const right = Buffer.from(provided);
        return left.length === right.length && crypto.timingSafeEqual(left, right);
    });
}

function calculateNextTrackingPoll({ status = "UNKNOWN", attempts = 0, now = new Date() } = {}) {
    if (isTerminalTrackingStatus(status)) return null;
    const attemptCount = Math.max(0, Number(attempts) || 0);
    const minutes = Math.min(360, attemptCount <= 1 ? 15 : 15 * (2 ** Math.min(attemptCount - 1, 4)));
    return new Date(new Date(now).getTime() + minutes * 60000).toISOString();
}

function trackingStatusLabel(status) {
    const labels = {
        PENDING: "Tracking pending",
        LABEL_CREATED: "Label created",
        PICKED_UP: "Picked up",
        IN_TRANSIT: "In transit",
        OUT_FOR_DELIVERY: "Out for delivery",
        AVAILABLE_FOR_PICKUP: "Available for pickup",
        DELIVERED: "Delivered",
        DELIVERY_ATTEMPTED: "Delivery attempted",
        EXCEPTION: "Delivery exception",
        RETURNED: "Returned",
        CANCELLED: "Cancelled",
        UNKNOWN: "Status unavailable"
    };
    return labels[normalizeTrackingStatus(status)] || labels.UNKNOWN;
}

module.exports = {
    TRACKING_STATUSES,
    afterShipCarrierSlug,
    calculateNextTrackingPoll,
    isTerminalTrackingStatus,
    normalizeAfterShipTracking,
    normalizeTrackingCarrier,
    normalizeTrackingStatus,
    sanitizeTrackingEvent,
    trackingEventFingerprint,
    trackingStatusLabel,
    verifyWebhookHmac
};
