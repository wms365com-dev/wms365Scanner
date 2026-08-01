const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const openapi = fs.readFileSync(path.join(__dirname, "docs", "wms365-partner-api-v1.yaml"), "utf8");

function liveRoutes() {
    return [...server.matchAll(/app\.(get|post|patch|put|delete)\("(\/api\/v1\/[^"?]+)"/g)]
        .map((match) => ({ method: match[1], path: match[2].replace(/^\/api\/v1/, "").replace(/:([^/]+)/g, "{$1}") }))
        .filter((route) => !["/openapi.yaml", "/changelog"].includes(route.path));
}

function documentedOperations() {
    const operations = new Set();
    let currentPath = "";
    for (const line of openapi.split(/\r?\n/)) {
        const pathMatch = line.match(/^  (\/[^:]+(?:\{[^}]+\})?):\s*$/);
        if (pathMatch) currentPath = pathMatch[1];
        const methodMatch = line.match(/^    (get|post|patch|put|delete):\s*$/);
        if (currentPath && methodMatch) operations.add(`${methodMatch[1]} ${currentPath}`);
    }
    return operations;
}

test("every live partner API operation is in OpenAPI", () => {
    const documented = documentedOperations();
    for (const route of liveRoutes()) {
        assert.ok(documented.has(`${route.method} ${route.path}`), `Missing OpenAPI operation: ${route.method.toUpperCase()} ${route.path}`);
    }
});

test("production API clients consume an exact customer approval", () => {
    assert.match(server, /Production access requires approval from an active customer portal user/);
    assert.match(server, /scopes @> \$4::text\[\] and scopes <@ \$4::text\[\]/);
    assert.match(server, /status = 'CONSUMED'/);
    assert.match(server, /\/api\/portal\/integration-approvals/);
});
