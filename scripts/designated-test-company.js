const DESIGNATED_TEST_COMPANY = Object.freeze({
    id: "1510",
    name: "CODEX PORTAL SYSTEM TEST"
});

async function requireDesignatedTestCompany(database) {
    const result = await database.query(
        `select id::text, name, is_active from owner_accounts
         where id = $1 and name = $2 and is_active = true`,
        [DESIGNATED_TEST_COMPANY.id, DESIGNATED_TEST_COMPANY.name]
    );
    const company = result.rows[0];
    if (result.rows.length !== 1
        || String(company?.id) !== DESIGNATED_TEST_COMPANY.id
        || company?.name !== DESIGNATED_TEST_COMPANY.name
        || company?.is_active !== true) {
        throw new Error("The designated test company is missing, inactive or has changed identity. Testing stopped; no customer-company fallback is allowed.");
    }
    return DESIGNATED_TEST_COMPANY;
}

module.exports = { DESIGNATED_TEST_COMPANY, requireDesignatedTestCompany };
