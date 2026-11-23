import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "outputs", "ranchers-current-released-orders");
const fullLabelQueue = process.argv.includes("--full-label-queue");
const skipLiveExport = process.argv.includes("--skip-live-export") || process.env.RANCHERS_SKIP_LIVE_EXPORT === "1";
const preparedPath = path.join(outputDir, fullLabelQueue
    ? "ranchers-full-label-queue.json"
    : "ranchers-new-orders-for-shipping-labels.json");
const builderPath = path.join(projectRoot, "outputs", "ranchers-orders-not-in-original-sheet", "build-ranchers-orders-not-in-sheet.mjs");
const preparePath = path.join(outputDir, "prepare-incremental-label-data.mjs");

function run(command, args, env = {}, shell = false) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        env: { ...process.env, ...env },
        encoding: "utf8",
        windowsHide: true,
        shell
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${String(result.error?.message || result.stderr || result.stdout || "unknown error").trim()}`);
    }
    return String(result.stdout || "").trim();
}

const railwayCommand = process.platform === "win32"
    ? path.join(projectRoot, "node_modules", ".bin", "railway.cmd")
    : path.join(projectRoot, "node_modules", ".bin", "railway");
if (!skipLiveExport) {
    run(railwayCommand, ["run", "node", "scripts/export-ranchers-current-released-orders-readonly.js", ...(fullLabelQueue ? ["--full-label-queue"] : [])], {
        RAILWAY_CALLER: "automation:ranchers-label-report",
        RAILWAY_AGENT_SESSION: `ranchers-label-${Date.now()}`
    }, process.platform === "win32");
}

if (!fullLabelQueue) run(process.execPath, [preparePath], { RANCHERS_LABEL_QUIET: "1" });
const prepared = JSON.parse(fs.readFileSync(preparedPath, "utf8"));
const newOrderCount = Number(prepared.audit?.exportedOrderCount || 0);
if (newOrderCount === 0) {
    console.log(JSON.stringify({ created: false, newOrderCount: 0 }));
    process.exit(0);
}

const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
}).formatToParts(new Date());
const value = (type) => parts.find((part) => part.type === type)?.value || "00";
const stamp = `${value("year")}-${value("month")}-${value("day")}_${value("hour")}${value("minute")}_ET`;
const outputPath = path.join(outputDir, fullLabelQueue
    ? `Ranchers_Chips_Released_and_Staged_Shipping_Labels_${stamp}.xlsx`
    : `Ranchers_Chips_New_Orders_Shipping_Labels_${stamp}.xlsx`);

run(process.execPath, [builderPath], {
    RANCHERS_LABEL_SOURCE: preparedPath,
    RANCHERS_LABEL_OUTPUT: outputPath,
    RANCHERS_LABEL_PREVIEW_DIR: outputDir,
    RANCHERS_LABEL_TITLE: fullLabelQueue
        ? "Rancher's Chips Shipping Labels - Released and Staged Orders"
        : "Rancher's Chips Shipping Labels - New Orders Only",
    RANCHERS_LABEL_DETAIL_TITLE: fullLabelQueue
        ? "Rancher's Chips - Complete Current Shipping Label Queue"
        : "Rancher's Chips - New Orders for Shipping Labels",
    RANCHERS_LABEL_QUIET: "1"
});

if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw new Error("The shipping-label workbook was not created correctly.");
}

console.log(JSON.stringify({
    created: true,
    newOrderCount,
    readyCount: prepared.details.filter((row) => row.data_check === "OK").length,
    reviewCount: prepared.details.filter((row) => row.data_check !== "OK").length,
    outputPath
}));
