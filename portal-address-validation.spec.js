const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.APP_SECRET ||= "portal-address-validation-test-secret";

const {
    normalizeAddressCountryCode,
    buildAddressFingerprint,
    validateManualShipToAddressShape,
    getConfiguredAddressProvider,
    getPortalAddressSuggestions,
    validatePortalShipToAddress,
    createPortalShipToAddressOverride,
    signAddressVerificationToken,
    verifyAddressVerificationToken,
    assertPortalShipToAddressCanRelease
} = require("./server");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const validAddress = {
    shipToName: "Cerelia USA Bakery, Inc",
    shipToAddress1: "4400 Poth Road",
    shipToAddress2: "",
    shipToCity: "Whitehall",
    shipToState: "OH",
    shipToPostalCode: "43213",
    shipToCountry: "US"
};

test("country aliases and address fingerprints normalize safely", () => {
    assert.equal(normalizeAddressCountryCode("Canada"), "CA");
    assert.equal(normalizeAddressCountryCode("USA"), "US");
    assert.equal(normalizeAddressCountryCode("Denmark"), "DK");
    assert.equal(
        buildAddressFingerprint(validAddress),
        buildAddressFingerprint({ ...validAddress, shipToName: "Different receiver", shipToAddress1: "4400 Poth Road.", shipToCountry: "USA" })
    );
});

test("manual address preflight rejects placeholders and malformed postal codes", () => {
    assert.match(
        validateManualShipToAddressShape({ ...validAddress, shipToAddress1: "123 Fake Street" }).join(" "),
        /real delivery address/i
    );
    assert.match(
        validateManualShipToAddressShape({ ...validAddress, shipToCountry: "Canada", regionCode: "CA", shipToPostalCode: "12345" }).join(" "),
        /Canadian postal code/i
    );
    assert.match(
        validateManualShipToAddressShape({ ...validAddress, shipToPostalCode: "ABC" }).join(" "),
        /US ZIP code/i
    );
});

test("signed verification is bound to the exact company and address", () => {
    const token = signAddressVerificationToken("TEST COMPANY", validAddress, { provider: "GOOGLE", responseId: "response-1" });
    assert.ok(verifyAddressVerificationToken(token, "TEST COMPANY", validAddress));
    assert.equal(verifyAddressVerificationToken(token, "ANOTHER COMPANY", validAddress), null);
    assert.equal(verifyAddressVerificationToken(token, "TEST COMPANY", { ...validAddress, shipToAddress1: "4401 Poth Road" }), null);
    assert.equal(verifyAddressVerificationToken(`${token}x`, "TEST COMPANY", validAddress), null);
});

test("Google suggestions are reduced to safe address-only fields", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            suggestions: [{ placePrediction: {
                placeId: "place-1",
                text: { text: "4400 Poth Road, Whitehall, OH 43213, USA" },
                structuredFormat: {
                    mainText: { text: "4400 Poth Road" },
                    secondaryText: { text: "Whitehall, OH 43213, USA" }
                }
            }}]
        })
    });
    try {
        const result = await getPortalAddressSuggestions({ query: "4400 Poth", country: "US", sessionToken: "session-1" }, { apiKey: "test-key" });
        assert.equal(result.available, true);
        assert.equal(result.suggestions.length, 1);
        assert.equal(result.suggestions[0].placeId, "place-1");
        assert.equal(result.suggestions[0].mainText, "4400 Poth Road");
    } finally {
        global.fetch = originalFetch;
    }
});

test("Geoapify free-tier adapter returns address suggestions without exposing its key to the portal", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.hostname, "api.geoapify.com");
        assert.equal(parsed.searchParams.get("apiKey"), "free-test-key");
        return {
            ok: true,
            json: async () => ({ results: [{
                place_id: "geo-1",
                formatted: "4400 Poth Road, Whitehall, OH 43213, United States",
                address_line1: "4400 Poth Road",
                address_line2: "Whitehall, OH 43213, United States"
            }] })
        };
    };
    try {
        const result = await getPortalAddressSuggestions(
            { query: "4400 Poth", country: "US" },
            { provider: "GEOAPIFY", apiKey: "free-test-key" }
        );
        assert.equal(result.available, true);
        assert.equal(result.provider, "GEOAPIFY");
        assert.equal(result.attribution, "Geoapify / OpenStreetMap");
        assert.equal(result.suggestions[0].placeId, "geo-1");
    } finally {
        global.fetch = originalFetch;
    }
});

test("Geoapify confidence response creates a releasable signed address", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ results: [{
            place_id: "geo-1",
            formatted: "4400 Poth Road, Whitehall, OH 43213, United States",
            address_line1: "4400 Poth Road",
            city: "Whitehall",
            state_code: "OH",
            postcode: "43213",
            country_code: "us",
            rank: { confidence: 0.98, confidence_building_level: 0.96, match_type: "full_match" }
        }] })
    });
    try {
        const result = await validatePortalShipToAddress(
            "TEST COMPANY",
            validAddress,
            { provider: "GEOAPIFY", apiKey: "free-test-key" }
        );
        assert.equal(result.status, "VERIFIED");
        assert.equal(result.provider, "GEOAPIFY");
        assert.ok(verifyAddressVerificationToken(result.verificationToken, "TEST COMPANY", result.recommendedAddress));
    } finally {
        global.fetch = originalFetch;
    }
});

test("provider ACCEPT response creates a releasable signed address", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        assert.doesNotMatch(String(url), /key=/i);
        assert.equal(options.headers["X-Goog-Api-Key"], "test-key");
        return {
            ok: true,
            json: async () => ({
                responseId: "response-1",
                result: {
                    verdict: { addressComplete: true, possibleNextAction: "ACCEPT" },
                    address: {
                        formattedAddress: "4400 Poth Rd, Whitehall, OH 43213, USA",
                        postalAddress: {
                            regionCode: "US",
                            addressLines: ["4400 Poth Rd"],
                            locality: "Whitehall",
                            administrativeArea: "OH",
                            postalCode: "43213"
                        },
                        missingComponentTypes: [],
                        unresolvedTokens: []
                    },
                    geocode: { placeId: "place-1" }
                }
            })
        };
    };
    try {
        const result = await validatePortalShipToAddress("TEST COMPANY", validAddress, { apiKey: "test-key" });
        assert.equal(result.status, "VERIFIED");
        assert.equal(result.canRelease, true);
        assert.ok(result.verificationToken);
        assert.ok(verifyAddressVerificationToken(result.verificationToken, "TEST COMPANY", result.recommendedAddress));
    } finally {
        global.fetch = originalFetch;
    }
});

test("provider FIX response and missing provider never claim verification", async () => {
    const unavailable = await validatePortalShipToAddress("TEST COMPANY", validAddress, { apiKey: "" });
    assert.equal(unavailable.status, "UNAVAILABLE");
    assert.equal(unavailable.canRelease, false);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            result: {
                verdict: { addressComplete: false, possibleNextAction: "FIX" },
                address: { postalAddress: {}, missingComponentTypes: ["street_number"], unresolvedTokens: [] }
            }
        })
    });
    try {
        const result = await validatePortalShipToAddress("TEST COMPANY", validAddress, { apiKey: "test-key" });
        assert.equal(result.status, "INVALID");
        assert.equal(result.canRelease, false);
        assert.equal(result.verificationToken, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test("portal release gate accepts trusted addresses and blocks pending or edited addresses", () => {
    assert.doesNotThrow(() => assertPortalShipToAddressCanRelease({
        ...validAddress,
        shipToAddressStatus: "VERIFIED",
        shipToAddressFingerprint: buildAddressFingerprint(validAddress)
    }, { addressValidationRequired: true }));
    assert.throws(() => assertPortalShipToAddressCanRelease(
        { ...validAddress, shipToAddressStatus: "PENDING" },
        { addressValidationRequired: true }
    ), /Verify this new ship-to address/i);
    assert.throws(() => assertPortalShipToAddressCanRelease({
        ...validAddress,
        shipToAddressStatus: "VERIFIED",
        shipToAddressFingerprint: buildAddressFingerprint(validAddress),
        shipToCity: "Columbus"
    }, { addressValidationRequired: true }), /Verify this new ship-to address/i);
    assert.doesNotThrow(() => assertPortalShipToAddressCanRelease(validAddress, { addressValidationRequired: false }));
    assert.throws(() => assertPortalShipToAddressCanRelease(
        { ...validAddress, shipToAddress1: "123 Fake Street" },
        { addressValidationRequired: false }
    ), /real delivery address/i);
});

test("manual address override requires an explicit reason and confirmation and is tenant-bound", () => {
    assert.throws(() => createPortalShipToAddressOverride("TEST COMPANY", {
        ...validAddress,
        overrideReason: "PROVIDER_NOT_FOUND"
    }), /Confirm that this is a real delivery address/i);
    const result = createPortalShipToAddressOverride("TEST COMPANY", {
        ...validAddress,
        overrideReason: "CARRIER_CONFIRMED",
        confirmationAccepted: true
    }, { portalAccessId: 22 });
    const token = verifyAddressVerificationToken(result.verificationToken, "TEST COMPANY", validAddress);
    assert.equal(result.status, "OVERRIDDEN");
    assert.equal(token.trustStatus, "OVERRIDDEN");
    assert.equal(token.overrideReason, "CARRIER_CONFIRMED");
    assert.equal(token.portalAccessId, 22);
    assert.doesNotThrow(() => assertPortalShipToAddressCanRelease({
        ...validAddress,
        shipToAddressStatus: "OVERRIDDEN",
        shipToAddressFingerprint: buildAddressFingerprint(validAddress)
    }));
});

test("customer portal exposes saved, suggested, manual, and verified address states", () => {
    assert.match(portalHtml, /id="orderSavedShipToAddress"/);
    assert.match(portalHtml, /Enter a new address/);
    assert.match(portalHtml, /id="orderShipToSuggestions"/);
    assert.match(portalHtml, /id="verifyShipToAddressBtn"/);
    assert.match(portalHtml, /id="manualOverrideShipToAddressBtn"/);
    assert.match(portalHtml, /id="shipToManualOverrideConfirmation"/);
    assert.match(portalHtml, /id="orderShipToVerificationStatus" aria-live="polite"/);
    assert.match(portalHtml, /shipToAddressVerificationToken/);
    assert.match(portalHtml, /New addresses must be verified before the order can be released/);
});

test("address endpoints are portal-authenticated and server release is enforced", () => {
    assert.match(serverSource, /app\.post\("\/api\/portal\/address-suggestions"[\s\S]*?requirePortalSession\(req\)/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/address-validation"[\s\S]*?requirePortalSession\(req\)/);
    assert.match(serverSource, /app\.post\("\/api\/portal\/address-override"[\s\S]*?requirePortalSession\(req\)/);
    assert.match(serverSource, /assertPortalShipToAddressCanRelease\(order\)/);
    assert.match(serverSource, /ship_to_address_status in \('SAVED','VERIFIED','OVERRIDDEN','PENDING','INTERNAL'\)/);
});
