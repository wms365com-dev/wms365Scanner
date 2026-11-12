const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
    const month = String(process.argv[2] || "").trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Usage: node scripts/download-healtea-month-end-report.js YYYY-MM [output.json]");
    const token = String(process.env.HEALTEA_API_TOKEN || "").trim();
    if (!token) throw new Error("HEALTEA_API_TOKEN is required.");
    const baseUrl = String(process.env.WMS365_API_BASE_URL || "https://app.wms365.co").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/api/healtea/v1/month-end/activity?month=${encodeURIComponent(month)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`WMS365 returned ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (!payload.success || payload.report?.accountName !== "HEALTEA" || payload.report?.period?.month !== month) {
        throw new Error("WMS365 returned an unexpected report scope.");
    }
    const outputPath = path.resolve(process.argv[3] || `healtea-month-end-${month}.json`);
    await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ success: true, month, outputPath, summary: payload.report.summary }));
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { main };
