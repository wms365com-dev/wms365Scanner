const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const root = __dirname;
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const portalHtml = fs.readFileSync(path.join(root, "portal.html"), "utf8");

test("desktop command bar exposes only controls with real action hooks", () => {
    assert.match(indexHtml, /id="desktopCommandShareBtn"/);
    assert.match(indexHtml, /desktopCommandShareBtn\?\.addEventListener\("click", copyDesktopCommandLink\)/);
    assert.match(indexHtml, /navigator\.clipboard\?\.writeText/);
    assert.match(indexHtml, /id="desktopCommandFindBtn"/);
    assert.match(indexHtml, /desktopCommandFindBtn\?\.addEventListener\("click", focusDesktopCommandSearch\)/);
    assert.match(indexHtml, /function getDesktopCommandSearchTarget\(\)/);
});

test("decorative and legacy controls are no longer rendered as buttons", () => {
    assert.doesNotMatch(indexHtml, /<button class="desktop-view-filter/);
    assert.doesNotMatch(indexHtml, /id="clearActiveCompanyBtnLegacy"/);
    assert.doesNotMatch(indexHtml, /title="Open in Excel"/);
    const remainingActionTabs = [...indexHtml.matchAll(/<button class="erp-action-tab[^>]*>/g)].map((match) => match[0]);
    assert.equal(remainingActionTabs.length, 7);
    assert.ok(remainingActionTabs.every((button) => button.includes("data-item-card-focus=")));
});

test("generated portal document clear controls expose an auditable delegated action hook", () => {
    assert.match(portalHtml, /data-clear-document-selection \$\{clearAttribute\}/);
    assert.match(portalHtml, /\[data-clear-document-selection\]\[data-clear-draft-documents\]/);
    assert.match(portalHtml, /\[data-clear-document-selection\]\[data-clear-draft-inbound-documents\]/);
});

test("the complete user-action map reports zero unresolved controls", () => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "audit-user-action-performance-map.js")], {
        cwd: root,
        encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.totals.unmappedButtons, 0);
    assert.equal(report.totals.mappedButtons, report.totals.buttons);
});
