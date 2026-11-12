function normalizeAccountName(value = "") {
    return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function parseReleaseAutoPrintAccounts(value = "") {
    return new Set(String(value || "")
        .split(/[;,\n]/)
        .map(normalizeAccountName)
        .filter(Boolean));
}

function isReleaseAutoPrintEnabled(accounts, accountName = "") {
    return accounts instanceof Set && accounts.has(normalizeAccountName(accountName));
}

async function enqueueReleaseAutoPrint(client, order, accounts) {
    if (!order?.id || !isReleaseAutoPrintEnabled(accounts, order.accountName)) return false;
    const result = await client.query(
        `
            insert into portal_order_release_auto_prints (order_id, account_name)
            values ($1, $2)
            on conflict (order_id) do nothing
            returning order_id
        `,
        [order.id, order.accountName]
    );
    return result.rowCount === 1;
}

function getReleaseAutoPrintRetrySeconds(attempts) {
    return Math.min(30 * (2 ** Math.max(0, Number(attempts || 1) - 1)), 30 * 60);
}

module.exports = {
    normalizeAccountName,
    parseReleaseAutoPrintAccounts,
    isReleaseAutoPrintEnabled,
    enqueueReleaseAutoPrint,
    getReleaseAutoPrintRetrySeconds
};
