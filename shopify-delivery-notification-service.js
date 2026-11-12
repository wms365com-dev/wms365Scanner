"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
    DEFAULT_ENABLED_EVENTS, SUPPORTED_EVENTS, SHOPIFY_SEND_STATES, SHOPIFY_NATIVE_EVENTS,
    evaluateDeliveryNotification, escapeHtml, safeUrl
} = require("./shopify-delivery-notifications");

function text(value, max = 240) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function sanitizeSettings(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings must be an object");
    const mode = input.mode === undefined ? "SHOPIFY" : input.mode;
    if (!["SHOPIFY", "WMS365", "BOTH"].includes(mode)) throw new TypeError("Invalid notification mode");
    const events = input.events === undefined ? [...DEFAULT_ENABLED_EVENTS] : input.events;
    if (!Array.isArray(events) || events.some((event) => !SUPPORTED_EVENTS.includes(event))) throw new TypeError("Invalid notification events");
    return {
        enabled: input.enabled === true, mode, events: [...new Set(events)],
        smsEnabled: input.smsEnabled === true,
        brandName: text(input.brandName), logoUrl: safeUrl(input.logoUrl),
        // Plain text only. Renderers escape it; unknown placeholders stay literal.
        messageTemplate: text(input.messageTemplate, 2000),
        shopifyNativeEvents: Object.fromEntries(SHOPIFY_NATIVE_EVENTS.map((event) => {
            const review = input.shopifyNativeEvents?.[event];
            const valid = ["ENABLED", "DISABLED", "UNKNOWN"].includes(review?.state)
                && text(review?.reviewedBy) && text(review?.evidenceRef)
                && typeof review?.reviewedAt === "string" && !Number.isNaN(Date.parse(review.reviewedAt))
                && text(review?.companyId) && text(review?.storeId);
            return [event, valid ? { state: review.state, reviewedAt: new Date(review.reviewedAt).toISOString(),
                reviewedBy: text(review.reviewedBy), evidenceRef: text(review.evidenceRef),
                companyId: text(review.companyId), storeId: text(review.storeId) } : { state: "UNKNOWN" }];
        }))
    };
}

async function transaction(db, work) {
    if (!db || typeof db.connect !== "function") throw new TypeError("db must provide connect() and dedicated clients");
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
        throw error;
    } finally {
        client.release();
    }
}

function validateScope(integrationId, accountName) {
    if (!/^\d+$/.test(String(integrationId)) || BigInt(integrationId) <= 0n || !text(accountName)) throw new TypeError("Exact integrationId and accountName required");
}

async function loadSettings(client, integrationId, accountName, exclusive = false) {
    validateScope(integrationId, accountName);
    const integration = await client.query(`SELECT id, account_name, provider, is_active
        FROM store_integrations WHERE id = $1 AND account_name = $2 FOR ${exclusive ? "UPDATE" : "SHARE"}`,
    [integrationId, accountName]);
    if (!integration.rows[0] || integration.rows[0].provider !== "SHOPIFY" || integration.rows[0].is_active !== true) {
        throw new Error("Active Shopify integration not found in this account");
    }
    const result = await client.query(`SELECT * FROM shopify_delivery_notification_settings
        WHERE integration_id = $1 FOR SHARE`, [integrationId]);
    const row = result.rows[0];
    const reviews = await client.query(`SELECT * FROM shopify_delivery_notification_native_reviews
        WHERE integration_id = $1 AND account_name = $2 FOR SHARE`, [integrationId, accountName]);
    const shopifyNativeEvents = Object.fromEntries(reviews.rows.map((review) => [review.event_type, {
        state: review.configuration_state, reviewedAt: new Date(review.reviewed_at).toISOString(),
        reviewedBy: review.reviewed_by, evidenceRef: review.evidence_ref,
        companyId: accountName, storeId: String(integrationId)
    }]));
    return row ? sanitizeSettings({ enabled: row.enabled, mode: row.delivery_mode, events: row.enabled_events,
            smsEnabled: row.sms_enabled, brandName: row.brand_name, logoUrl: row.logo_url,
            messageTemplate: row.message_template, shopifyNativeEvents })
        : sanitizeSettings({ shopifyNativeEvents });
}

async function getDeliveryNotificationSettings({ db, integrationId, accountName }) {
    return transaction(db, (client) => loadSettings(client, integrationId, accountName));
}

async function setDeliveryNotificationSettings({ db, integrationId, accountName, settings }) {
    const sanitized = sanitizeSettings(settings);
    return transaction(db, async (client) => {
        // All service readers lock the integration too, including when no settings row exists.
        await loadSettings(client, integrationId, accountName, true);
        await client.query(`INSERT INTO shopify_delivery_notification_settings
            (integration_id, enabled, delivery_mode, enabled_events, sms_enabled, brand_name, logo_url, message_template)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
            ON CONFLICT (integration_id) DO UPDATE SET enabled = EXCLUDED.enabled,
            delivery_mode = EXCLUDED.delivery_mode, enabled_events = EXCLUDED.enabled_events,
            sms_enabled = EXCLUDED.sms_enabled, brand_name = EXCLUDED.brand_name,
            logo_url = EXCLUDED.logo_url, message_template = EXCLUDED.message_template, updated_at = now()`,
        [integrationId, sanitized.enabled, sanitized.mode, JSON.stringify(sanitized.events), sanitized.smsEnabled,
            sanitized.brandName, sanitized.logoUrl, sanitized.messageTemplate]);
        await client.query(`UPDATE shopify_delivery_notification_outbox SET status = 'PENDING', updated_at = now()
            WHERE integration_id = $1 AND account_name = $2 AND status = 'DEFERRED'`, [integrationId, accountName]);
        return loadSettings(client, integrationId, accountName);
    });
}

// Routes must supply the authenticated reviewer, not a reviewer from the UI body.
// Generic settings updates deliberately cannot write verification or audit records.
async function recordShopifyNotificationConfiguration({ db, integrationId, accountName, event,
    state, reviewedBy, evidenceRef }) {
    if (!SHOPIFY_NATIVE_EVENTS.includes(event) || !["ENABLED", "DISABLED", "UNKNOWN"].includes(state)
        || !text(reviewedBy) || !text(evidenceRef)) throw new TypeError("Native event, configuration state and review evidence required");
    return transaction(db, async (client) => {
        await loadSettings(client, integrationId, accountName, true);
        await client.query(`INSERT INTO shopify_delivery_notification_native_reviews
            (integration_id, account_name, event_type, configuration_state, reviewed_at, reviewed_by, evidence_ref)
            VALUES ($1,$2,$3,$4,now(),$5,$6)
            ON CONFLICT (integration_id, account_name, event_type) DO UPDATE SET
                configuration_state = EXCLUDED.configuration_state, reviewed_at = now(),
                reviewed_by = EXCLUDED.reviewed_by, evidence_ref = EXCLUDED.evidence_ref`,
        [integrationId, accountName, event, state, text(reviewedBy), text(evidenceRef)]);
        await client.query(`INSERT INTO shopify_delivery_notification_review_audit
            (integration_id, account_name, event_type, configuration_state, reviewed_by, evidence_ref)
            VALUES ($1,$2,$3,$4,$5,$6)`, [integrationId, accountName, event, state, text(reviewedBy), text(evidenceRef)]);
        await client.query(`UPDATE shopify_delivery_notification_outbox SET status = 'PENDING', updated_at = now()
            WHERE integration_id = $1 AND account_name = $2 AND event_type = $3 AND status = 'DEFERRED'`,
        [integrationId, accountName, event]);
        return loadSettings(client, integrationId, accountName);
    });
}

function getDeliveryNotificationCapabilities(provider) {
    const validId = Boolean(text(provider?.id) && provider.id === text(provider.id));
    return { emailConfigured: validId && provider.emailConfigured === true && typeof provider.sendEMAIL === "function",
        smsConfigured: validId && provider.smsConfigured === true && typeof provider.sendSMS === "function" };
}

function policyInput(settings, integrationId, accountName, shipment, event, recipient, state) {
    return {
        store: { id: String(integrationId), companyId: accountName,
            notificationMode: settings.mode === "WMS365" ? "WMS" : settings.mode,
            enabledEvents: settings.events, smsEnabled: settings.smsEnabled,
            shopifyNativeEvents: settings.shopifyNativeEvents,
            branding: { name: settings.brandName, logoUrl: settings.logoUrl } },
        shipment, event, recipient, shopifySendState: state
    };
}

function dedupKey(notification) {
    return createHash("sha256").update(JSON.stringify([notification.key, notification.to])).digest("hex");
}

/** Enqueues only; shipment.companyId is the exact WMS account_name and storeId the integration ID.
 * Callers authorize warehouse/order ownership before calling. No database is opened by this module.
 * Provenance is an allowlist, never an arbitrary provider payload or credential-bearing integration.
 */
async function enqueueDeliveryNotifications({ db, integrationId, accountName, shipment, event, recipient,
    shopifySendState = "UNKNOWN", provenance = {} }) {
    return transaction(db, async (client) => {
        const settings = await loadSettings(client, integrationId, accountName);
        if (!settings.enabled) return { decision: "SUPPRESS", reason: "SETTINGS_OFF", queued: [] };
        const state = SHOPIFY_SEND_STATES.includes(shopifySendState) ? shopifySendState : "UNKNOWN";
        const input = policyInput(settings, integrationId, accountName, shipment, event, recipient, state);
        const result = evaluateDeliveryNotification(input);
        // Capture eligible deferred recipients without pretending Shopify sent anything.
        const candidates = result.decision === "DEFER" || result.reason === "SHOPIFY_REQUESTED"
            ? evaluateDeliveryNotification({ ...input, store: { ...input.store, notificationMode: "BOTH" } }).notifications
            : result.notifications;
        const queued = [];
        for (const notification of candidates) {
            const key = dedupKey(notification);
            const payload = {
                shipment: { ...result.scope, id: result.scope.shipmentId, storeId: result.scope.storeId,
                    orderNumber: notification.content.orderNumber, carrier: notification.content.carrier,
                    trackingNumber: notification.content.trackingNumber, trackingUrl: notification.content.trackingUrl },
                event: { status: notification.content.status, eventAt: notification.content.eventAt,
                    description: notification.content.scan, location: notification.content.location,
                    estimatedDelivery: notification.content.estimatedDelivery },
                recipient: { [notification.channel === "EMAIL" ? "email" : "phone"]: notification.to,
                    smsConsent: recipient.smsConsent === true }
            };
            const inserted = await client.query(`INSERT INTO shopify_delivery_notification_outbox
                (integration_id, account_name, warehouse_id, order_id, shipment_id, event_type,
                 delivery_mode, channel, recipient, recipient_consent, provenance, payload, shopify_send_state, dedup_key, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)
                ON CONFLICT (integration_id, account_name, dedup_key) DO NOTHING RETURNING id, dedup_key, status`,
            [integrationId, accountName, result.scope.warehouseId, result.scope.orderId, result.scope.shipmentId,
                notification.content.status, settings.mode, notification.channel, notification.to, recipient.smsConsent === true,
                JSON.stringify({ sourceType: text(provenance.sourceType, 80), sourceRef: text(provenance.sourceRef, 180),
                    shopifyEvidenceRef: text(provenance.shopifyEvidenceRef, 180),
                    notificationSource: state === "REQUESTED" ? "SHOPIFY_REQUESTED" : "WMS" }),
                JSON.stringify(payload), state, key, result.decision === "DEFER" ? "DEFERRED"
                    : result.reason === "SHOPIFY_REQUESTED" ? "SUPPRESSED" : "PENDING"]);
            queued.push(...inserted.rows);
        }
        return { decision: result.decision, reason: result.reason, queued };
    });
}

async function recordShopifySendState({ db, integrationId, accountName, dedupKey: key, state }) {
    if (!["REQUESTED", "SENT", "NOT_SENT"].includes(state) || !/^[a-f0-9]{64}$/.test(key)) throw new TypeError("Confirmed state and dedupKey required");
    return transaction(db, async (client) => {
        await loadSettings(client, integrationId, accountName);
        const result = await client.query(`UPDATE shopify_delivery_notification_outbox
            SET shopify_send_state = $4, status = 'PENDING', updated_at = now()
            WHERE integration_id = $1 AND account_name = $2 AND dedup_key = $3
              AND status IN ('DEFERRED', 'PENDING') AND shopify_send_state = 'UNKNOWN'
              RETURNING id, status`, [integrationId, accountName, key, state]);
        return result.rows;
    });
}

function applyTemplate(notification, settings) {
    const values = { ...notification.content, brandName: notification.content.branding.name };
    const message = settings.messageTemplate.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        typeof values[name] === "string" ? values[name] : match);
    return { ...notification, text: notification.text + (message ? `\n${message}` : ""),
        html: notification.html + (message ? `\n<p>${escapeHtml(message)}</p>` : "") };
}

async function finish(client, row, token, status, code, messageId = "") {
    const result = await client.query(`UPDATE shopify_delivery_notification_outbox
        SET status = $3, outcome_code = $4, provider_message_id = $5,
            sent_at = CASE WHEN $3 = 'SENT' THEN now() ELSE NULL END,
            claim_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND claim_token = $2 AND status = 'SENDING' RETURNING id, status`,
    [row.id, token, status, code, messageId]);
    if (!result.rows.length) throw new Error("Delivery claim lost; send outcome needs reconciliation");
    return result.rows[0];
}

async function sendWithTimeout(send, message, timeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => send({ ...message, signal: controller.signal })),
            new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error("SEND_TIMEOUT")); }, timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Provider sends must resolve {state:'SENT', messageId} or {state:'NOT_SENT'}.
 * Exceptions, timeouts and non-receipts are UNCERTAIN, never successful.
 * supportsIdempotency:true is a provider contract: the same id/key must deduplicate
 * across process crashes, concurrent retries and the entire retry retention period.
 * Configured channels require explicit emailConfigured/smsConfigured:true and a
 * corresponding send method. resolveRecipient is required for SMS and must return
 * current consent/contact. Shopify REQUESTED is not a provider send receipt.
 * Optional validateEvent({client,row}) runs under the send transaction's row and
 * settings locks. Return true to authorize sending; any other result suppresses
 * with DELIVERY_EVIDENCE_UNVERIFIED, and exceptions suppress with EVENT_UNVERIFIED.
 * Use client for scoped FOR SHARE evidence checks so locks remain held through send.
 * Row claims commit before external effects; finalization uses a token. Stale claims
 * become UNCERTAIN. No provider/key change can replay an ambiguous delivery.
 */
async function runDeliveryNotificationWorker({ db, provider, limit = 10, timeoutMs = 30000,
    maxAttempts = 3, resolveRecipient, validateEvent }) {
    if (!provider || !text(provider.id) || provider.id !== text(provider.id)) throw new TypeError("Stable provider.id required");
    if (validateEvent !== undefined && typeof validateEvent !== "function") throw new TypeError("validateEvent must be a function");
    for (const [name, value, max] of [["limit", limit, 100], ["timeoutMs", timeoutMs, 120000], ["maxAttempts", maxAttempts, 10]]) {
        if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${name}`);
    }
    const outcomes = [];
    await transaction(db, (client) => client.query(`UPDATE shopify_delivery_notification_outbox
        SET status = 'UNCERTAIN', outcome_code = 'STALE_CLAIM', claim_token = NULL,
            lease_expires_at = NULL, updated_at = now()
        WHERE status = 'SENDING' AND lease_expires_at < now()`));
    for (let index = 0; index < limit; index++) {
        const claim = await transaction(db, async (client) => {
            const selected = await client.query(`SELECT o.* FROM shopify_delivery_notification_outbox o
                WHERE o.status = 'PENDING' OR (o.status = 'UNCERTAIN' AND $1 = true
                    AND o.provider_id = $2 AND o.attempts < $3)
                ORDER BY o.created_at, o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
            [provider.supportsIdempotency === true, provider.id, maxAttempts]);
            const row = selected.rows[0];
            if (!row) return null;
            const token = randomUUID();
            await client.query(`UPDATE shopify_delivery_notification_outbox SET status = 'SENDING',
                provider_id = $2, claim_token = $3, attempts = attempts + 1,
                lease_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
                WHERE id = $1`, [row.id, provider.id, token, timeoutMs + 60000]);
            return { row, token };
        });
        if (!claim) break;
        const { row, token } = claim;
        // Keep the row and settings locks through send/finalization. A crash rolls
        // this transaction back to the committed SENDING claim, not to PENDING.
        const outcome = await transaction(db, async (client) => {
            const locked = await client.query(`SELECT id FROM shopify_delivery_notification_outbox
                WHERE id = $1 AND claim_token = $2 AND status = 'SENDING' FOR UPDATE`, [row.id, token]);
            if (!locked.rows.length) return { id: row.id, status: "UNCERTAIN" };
            let settings;
            try { settings = await loadSettings(client, row.integration_id, row.account_name); }
            catch (error) {
                if (error.message !== "Active Shopify integration not found in this account") throw error;
                return finish(client, row, token, "SUPPRESSED", "INTEGRATION_UNAVAILABLE");
            }
            if (!settings.enabled) return finish(client, row, token, "SUPPRESSED", "SETTINGS_OFF");
            if (row.channel === "SMS" && typeof resolveRecipient !== "function") {
                return finish(client, row, token, "SUPPRESSED", "CURRENT_SMS_CONSENT_REQUIRED");
            }
            let recipient = row.payload.recipient;
            if (typeof resolveRecipient === "function") {
                try { recipient = await resolveRecipient({ accountName: row.account_name,
                    integrationId: row.integration_id, warehouseId: row.warehouse_id,
                    orderId: row.order_id, channel: row.channel, recipient: row.recipient }); }
                catch { return finish(client, row, token, "SUPPRESSED", "RECIPIENT_UNVERIFIED"); }
            }
            const result = evaluateDeliveryNotification(policyInput(settings, row.integration_id, row.account_name,
                row.payload.shipment, row.payload.event, recipient || {}, row.shopify_send_state));
            if (result.decision === "DEFER") return finish(client, row, token, "DEFERRED", result.reason);
            const notification = result.notifications.find((item) => item.channel === row.channel && item.to === row.recipient);
            if (!notification) return finish(client, row, token, "SUPPRESSED", result.reason === "EVENT_DISABLED" ? result.reason : "POLICY_OR_RECIPIENT_CHANGED");
            if (dedupKey(notification) !== row.dedup_key) return finish(client, row, token, "SUPPRESSED", "PAYLOAD_SCOPE_CHANGED");
            const send = provider[`send${row.channel}`];
            const capabilities = getDeliveryNotificationCapabilities(provider);
            if (typeof send !== "function" || !capabilities[row.channel === "EMAIL" ? "emailConfigured" : "smsConfigured"]) {
                return finish(client, row, token, "FAILED", "PROVIDER_CHANNEL_UNAVAILABLE");
            }
            if (validateEvent) {
                let verified;
                try { verified = await validateEvent({ client, row }); }
                catch { return finish(client, row, token, "SUPPRESSED", "EVENT_UNVERIFIED"); }
                if (verified !== true) return finish(client, row, token, "SUPPRESSED", "DELIVERY_EVIDENCE_UNVERIFIED");
            }
            let receipt;
            try {
                receipt = await sendWithTimeout(send.bind(provider), {
                    ...applyTemplate(notification, settings), idempotencyKey: row.dedup_key,
                    scope: result.scope, deliveryMode: settings.mode
                }, timeoutMs);
            } catch {
                return finish(client, row, token, "UNCERTAIN", "SEND_ERROR_OR_TIMEOUT");
            }
            if (receipt?.state === "SENT" && text(receipt.messageId)) {
                return finish(client, row, token, "SENT", "PROVIDER_CONFIRMED", text(receipt.messageId));
            }
            if (receipt?.state === "NOT_SENT") return finish(client, row, token, "FAILED", "PROVIDER_CONFIRMED_NOT_SENT");
            return finish(client, row, token, "UNCERTAIN", "NO_CONFIRMED_RECEIPT");
        });
        outcomes.push(outcome);
    }
    return outcomes;
}

module.exports = {
    sanitizeSettings, getDeliveryNotificationSettings, setDeliveryNotificationSettings,
    enqueueDeliveryNotifications, recordShopifySendState, runDeliveryNotificationWorker,
    recordShopifyNotificationConfiguration, getDeliveryNotificationCapabilities
};
