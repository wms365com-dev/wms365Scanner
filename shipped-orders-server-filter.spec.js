const fs = require("fs");
const path = require("path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const customerPortal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");

if (!server.includes('const requestedStatusInput = normalizeText(req.query?.status || "");')) {
    throw new Error("Admin order API does not read the requested server-side status filter.");
}
if (!server.includes("filters.push(`o.status = $${params.length}`);")) {
    throw new Error("Portal order query does not apply an exact server-side status filter.");
}
if (!server.includes('throw httpError(400, "Choose a valid sales order status.");')) {
    throw new Error("Invalid order status filters are not rejected.");
}
if (!desktop.includes('if (isShippedOrdersSection()) return "SHIPPED";')
    || !desktop.includes('return norm(ui.portalOrderStatusFilter?.value || "");')) {
    throw new Error("Shipped Orders and the Sales Orders status filter do not request their selected status from the server.");
}
if (!desktop.includes('if (status) params.set("status", status);')) {
    throw new Error("Desktop order requests omit the server-side status query.");
}
if (!desktop.includes('`${norm(company) || "__ALL_COMPANIES__"}::${norm(status) || "ALL"}`')) {
    throw new Error("Order cache keys do not isolate server-side status result sets.");
}
if (!desktop.includes('refreshPortalOrdersList(false, { showLoading: true })')) {
    throw new Error("Changing or clearing the Sales Orders status filter does not refresh records from the server.");
}
if (!desktop.includes('&& getPortalOrdersRequestStatus() === statusKey;')) {
    throw new Error("Rapid Sales Orders filter changes can still apply stale server responses.");
}
if (!server.includes('orders: await getPortalOrdersForAccount(session.access.accountName, pool, { status: requestedStatus })')) {
    throw new Error("Customer portal order API does not pass its validated status filter to the account-scoped query.");
}
if (!server.includes('const filters = ["o.account_name = $1", "o.status <> \'ARCHIVED\'"];')) {
    throw new Error("Customer shipped-order query is not anchored to the authenticated customer account.");
}
if (!customerPortal.includes('requestJson("/api/portal/orders?status=SHIPPED")')) {
    throw new Error("Customer Shipped Orders does not request complete shipped history from the server.");
}
if (!customerPortal.includes("[ordersPayload, shippedOrdersPayload].forEach((payload) =>")) {
    throw new Error("Customer portal does not safely merge current and shipped order result sets.");
}

console.log("Shipped order server-filter regression checks passed.");
