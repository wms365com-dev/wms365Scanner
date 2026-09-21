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

test("approved billing events permit one-time ownership backfill during fresh database boot", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const triggerStart = source.indexOf("create or replace function protect_and_audit_billing_event");
    const triggerEnd = source.indexOf("$$ language plpgsql", triggerStart);
    const trigger = source.slice(triggerStart, triggerEnd);

    assert.ok(triggerStart >= 0 && triggerEnd > triggerStart, "billing event protection trigger is missing");
    for (const field of ["master_customer_id", "master_customer_name", "sub_customer_id", "sub_customer_name"]) {
        assert.match(trigger, new RegExp(`'${field}'`), `${field} must be included in the controlled backfill`);
    }
    assert.match(trigger, /nullif\(trim\(coalesce\(to_jsonb\(old\) ->> backfill_field\.field_name, ''\)\), ''\) is not null/);
    assert.match(trigger, /raise exception 'Approved billing source facts are locked; create a void or credit event'/);
});
