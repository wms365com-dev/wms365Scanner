const { GoogleAuth } = require("google-auth-library");
const { build, HEADERS } = require("./scripts/prepare-ranchers-clickship-rows");

const SPREADSHEET_ID = "1aAPQq5KemA2sALJOm7G1MYloFwssl6u_k5B-KLXOdw0";
const WMS_TAB = "WMS";
const SOURCE_TAB = "Sheet1";
const LOCK_KEYS = [365, 20260928];
const MAX_BATCH = 100;

function uniqueOrderCodes(values) {
    return new Set((values || []).slice(1).map((row) => String(row?.[0] || "").trim()).filter((value) => /^ORD-\d{6}$/.test(value)));
}

function hasDuplicateOrderCodes(values) {
    const codes = (values || []).slice(1).map((row) => String(row?.[0] || "").trim()).filter((value) => /^ORD-\d{6}$/.test(value));
    return new Set(codes).size !== codes.length;
}

function planRows(snapshot, wmsColumn, sourceColumn) {
    const eligible = new Set(["RELEASED", "STAGED"]);
    const { headers, rows } = build({ ...snapshot,
        orders: snapshot.orders.filter((order) => eligible.has(order.status)) });
    const existing = new Set([...uniqueOrderCodes(wmsColumn), ...uniqueOrderCodes(sourceColumn)]);
    const append = rows.filter((row) => !existing.has(row[1]));
    if (new Set(append.map((row) => row[1])).size !== append.length) {
        throw new Error("Duplicate order in planned label-sheet rows");
    }
    return { headers, append, candidateCount: rows.length, alreadyPresent: rows.length - append.length };
}

function configuredGoogleAuth(env = process.env) {
    const raw = String(env.RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON || "").trim();
    let credentials;
    if (raw) {
        try {
            credentials = JSON.parse(raw);
        } catch (_error) {
            throw new Error("RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON is invalid JSON");
        }
        if (credentials.type !== "service_account" || !credentials.client_email || !credentials.private_key) {
            throw new Error("RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON is not a valid service account credential");
        }
    } else if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error("Set RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
    }
    return new GoogleAuth({
        ...(credentials ? { credentials } : {}),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
}

class SheetsClient {
    constructor(auth) {
        this.auth = auth;
        this.base = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
    }

    async request(method, path, data) {
        const client = await this.auth.getClient();
        try {
            const response = await client.request({ method, url: `${this.base}${path}`, ...(data ? { data } : {}) });
            return response.data;
        } catch (error) {
            throw new Error(`Google Sheets ${method} failed (HTTP ${error.response?.status || "unavailable"})`);
        }
    }

    async readState() {
        const metadata = await this.request("GET", "?fields=sheets(properties(title,gridProperties))");
        const titles = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
        if (!titles.has(WMS_TAB) || !titles.has(SOURCE_TAB)) throw new Error("Required Rancher's sheet tabs are missing");
        const ranges = ["'WMS'!A1:AF1", "'WMS'!B1:B", "'Sheet1'!B1:B"];
        const params = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE" });
        for (const range of ranges) params.append("ranges", range);
        const response = await this.request("GET", `/values:batchGet?${params}`);
        const [header, wmsColumn, sourceColumn] = response.valueRanges || [];
        if (!header || !wmsColumn || !sourceColumn) throw new Error("Sheet read did not return every required range");
        if (JSON.stringify(header.values?.[0] || []) !== JSON.stringify(HEADERS)) {
            throw new Error("WMS tab headers changed; sync stopped before writing");
        }
        if (String(wmsColumn.values?.[0]?.[0] || "") !== "WMS Order"
            || String(sourceColumn.values?.[0]?.[0] || "") !== "WMS Order") {
            throw new Error("WMS order key column changed; sync stopped before writing");
        }
        if (hasDuplicateOrderCodes(wmsColumn.values)) {
            throw new Error("WMS tab already has duplicate order numbers; sync stopped before writing");
        }
        return { header: header.values[0], wmsColumn: wmsColumn.values, sourceColumn: sourceColumn.values };
    }

    async appendRows(rows) {
        const url = `/values/${encodeURIComponent("'WMS'!A:AF")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
        return this.request("POST", url, { majorDimension: "ROWS", values: rows });
    }

    async readAppendedOrderCodes(updatedRange) {
        const match = String(updatedRange || "").match(/!A(\d+):AF(\d+)$/);
        if (!match) throw new Error("Google did not return a verifiable appended range");
        const start = Number(match[1]);
        const end = Number(match[2]);
        const range = encodeURIComponent(`'WMS'!B${start}:B${end}`);
        const response = await this.request("GET", `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
        return (response.values || []).map((row) => String(row[0] || ""));
    }
}

async function syncOnce({ database, sheets, loadSnapshot }) {
    const lock = await database.query("select pg_try_advisory_lock($1, $2) as acquired", LOCK_KEYS);
    if (!lock.rows[0]?.acquired) return { state: "BUSY", appended: [] };
    try {
        const snapshot = await loadSnapshot(database);
        const initial = await sheets.readState();
        let plan = planRows(snapshot, initial.wmsColumn, initial.sourceColumn);
        if (!plan.append.length) return { state: "UNCHANGED", appended: [], candidates: plan.candidateCount };

        // Re-read the destination just before each append, including after a prior batch.
        const appended = [];
        let batchCount = 0;
        while (plan.append.length && batchCount < 10) {
            const current = await sheets.readState();
            const latestSnapshot = await loadSnapshot(database);
            plan = planRows(latestSnapshot, current.wmsColumn, current.sourceColumn);
            if (!plan.append.length) break;
            const batch = plan.append.slice(0, MAX_BATCH);
            const response = await sheets.appendRows(batch);
            const range = response.updates?.updatedRange;
            const got = await sheets.readAppendedOrderCodes(range);
            const expected = batch.map((row) => row[1]);
            if (JSON.stringify(got) !== JSON.stringify(expected)) {
                throw new Error("Appended Google Sheet rows did not match the WMS order numbers");
            }
            appended.push(...expected);
            batchCount += 1;
        }
        return { state: plan.append.length ? "PARTIAL" : "UPDATED", appended, candidates: plan.candidateCount };
    } finally {
        await database.query("select pg_advisory_unlock($1, $2)", LOCK_KEYS);
    }
}

module.exports = { SPREADSHEET_ID, WMS_TAB, SOURCE_TAB, SheetsClient, configuredGoogleAuth, planRows, syncOnce, uniqueOrderCodes, hasDuplicateOrderCodes };
