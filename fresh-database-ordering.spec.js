const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("fresh database creates warehouse users before access restriction audit references them", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const appUsersCreate = source.indexOf("create table if not exists app_users");
    const accessRestrictionCreate = source.indexOf("create table if not exists access_restriction_log");
    assert.ok(appUsersCreate >= 0, "app_users boot schema is missing");
    assert.ok(accessRestrictionCreate >= 0, "access_restriction_log boot schema is missing");
    assert.ok(appUsersCreate < accessRestrictionCreate, "app_users must exist before its audit-log foreign key is created");
});

test("health stays unavailable until the complete database schema is initialized", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(source, /let databaseSchemaInitialized = false/);
    assert.match(source, /const healthy = databaseSchemaInitialized && databaseReady && probe\.ok && entryRoutesReady/);
    assert.match(source, /await applyPendingAdditiveMigrations\(initializationLockClient\);\s*if \(!\(await databaseSchemaContractIsCurrent\(initializationLockClient\)\)\) \{\s*await initializeDatabase\(\);\s*\}\s*await recordDatabaseSchemaVersion\(\);\s*markDatabaseInitializationComplete\(\);/);
    assert.match(source, /function markDatabaseInitializationComplete[\s\S]*databaseSchemaInitialized = true;\s*databaseReady = true;/);
});

test("rolling schema initialization is serialized and retries bounded lock waits", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(source, /const DATABASE_SESSION_LOCK_TIMEOUT_MS = Math\.max\(500,/);
    assert.match(source, /options: `-c lock_timeout=\$\{DATABASE_SESSION_LOCK_TIMEOUT_MS\}`/);
    assert.match(source, /pg_try_advisory_lock\(hashtextextended\(\$1, 0\)\)/);
    assert.match(source, /WMS365_SCHEMA_INITIALIZATION_BUSY/);
    assert.match(source, /pg_advisory_unlock\(hashtextextended\(\$1, 0\)\)/);
    assert.match(source, /initializationLockClient\.release\(\)/);
    assert.match(source, /Database initialization failed\. Retrying in 5 seconds\./);
});
