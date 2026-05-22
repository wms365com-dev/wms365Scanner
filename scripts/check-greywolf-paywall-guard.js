const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server.js");
const docsPath = path.join(root, "docs", "WMS365_PRICING_PAYWALL.md");

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function indexOfOrThrow(source, token) {
    const index = source.indexOf(token);
    assert(index >= 0, `Missing required token: ${token}`);
    return index;
}

const server = fs.readFileSync(serverPath, "utf8");
const docs = fs.readFileSync(docsPath, "utf8");

const blockedIndex = indexOfOrThrow(server, 'if (ownerAccessMode === "BLOCKED")');
const noChargeIndex = indexOfOrThrow(server, 'if (ownerAccessMode === "NO_CHARGE" || greyWolfNoCharge)');
const stripeIndex = indexOfOrThrow(server, "if (stripeAllowed)");
const monitorOnlyIndex = indexOfOrThrow(server, "if (!PAYWALL_ENFORCEMENT_ENABLED)");

assert(blockedIndex < noChargeIndex, "Blocked companies must stay blocked before no-charge bypasses are evaluated.");
assert(noChargeIndex < stripeIndex, "Grey Wolf/no-charge access must be evaluated before Stripe subscription checks.");
assert(stripeIndex < monitorOnlyIndex, "Stripe checks should run before monitor-only fallback.");

indexOfOrThrow(server, "const DEFAULT_FULFILLMENT_LOCATION = Object.freeze({");
indexOfOrThrow(server, 'code: "GW3PL-MISS"');
indexOfOrThrow(server, "companyHasGreyWolfFulfillmentAssignment");
indexOfOrThrow(server, "return result.rows.some(isGreyWolfFulfillmentLocationRow);");
indexOfOrThrow(server, "No software charge: company is assigned to Grey Wolf 3PL.");
indexOfOrThrow(server, "ensureCompanyDefaultFulfillmentAssignment");
indexOfOrThrow(server, "await assertCompanyPaywallAccess(client, vendorAccess.account_name);");
indexOfOrThrow(server, "const paywallStatus = await getCompanyPaywallStatus(pool, access.account_name);");
indexOfOrThrow(server, "const paywallStatus = await getCompanyPaywallStatus(client, existing.account_name);");

indexOfOrThrow(docs, "Company is assigned to a Grey Wolf 3PL fulfillment location");
indexOfOrThrow(docs, "Grey Wolf-assigned companies get no-charge portal access");

console.log("Grey Wolf no-charge paywall guard passed.");
