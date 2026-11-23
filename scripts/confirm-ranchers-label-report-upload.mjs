import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pendingPath = path.join(projectRoot, "outputs", "ranchers-current-released-orders", "ranchers-new-orders-for-shipping-labels.json");
const stateDir = path.join(projectRoot, "automation-state");
const statePath = path.join(stateDir, "ranchers-label-export-state.json");

const [pending, existing] = await Promise.all([
    fs.readFile(pendingPath, "utf8").then(JSON.parse),
    fs.readFile(statePath, "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return { exportedOrderCodes: [] };
        throw error;
    })
]);

const exportedOrderCodes = [...new Set([
    ...(existing.exportedOrderCodes || []),
    ...(pending.orders || []).map((order) => order.order_code)
])].sort();

await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(statePath, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    exportedOrderCodes
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ confirmed: true, totalRecordedOrders: exportedOrderCodes.length }));
