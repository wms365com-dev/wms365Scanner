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
    assert.match(source, /await initializeDatabase\(\);\s*databaseSchemaInitialized = true;\s*databaseReady = true;/);
});
