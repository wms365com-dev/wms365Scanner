const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("open utility menus rise above document overlays without permanently raising the header", () => {
    assert.match(source, /body\.utility-menu-open \.hero\s*\{\s*z-index:\s*3500;/);
    assert.match(source, /body\.sales-order-popout-open::before[\s\S]*?z-index:\s*3400;/);
    assert.match(source, /body\.sales-order-popout-open #warehouseOrderEntryCard[\s\S]*?z-index:\s*3410;/);
    assert.match(source, /\.hero\s*\{[\s\S]*?z-index:\s*1200;/);
});

test("utility overlay state follows both menu open properties", () => {
    assert.match(source, /function syncUtilityMenuOverlayState\(\)\s*\{[\s\S]*?ui\.desktopCompanySwitcher\?\.open \|\| ui\.accountSettingsMenu\?\.open[\s\S]*?classList\.toggle\("utility-menu-open", utilityMenuOpen\);/);
    assert.match(source, /accountSettingsMenu\?\.addEventListener\("toggle", \(\) => \{[\s\S]*?syncUtilityMenuOverlayState\(\);\s*\}\);/);
    assert.match(source, /desktopCompanySwitcher\?\.addEventListener\("toggle", \(\) => \{[\s\S]*?syncUtilityMenuOverlayState\(\);\s*\}\);/);
});

test("both close buttons explicitly close their menu and restore overlay state", () => {
    assert.match(source, /accountSettingsCloseBtn\?\.addEventListener\("click", \(\) => \{\s*if \(ui\.accountSettingsMenu\) ui\.accountSettingsMenu\.open = false;\s*syncUtilityMenuOverlayState\(\);/);
    assert.match(source, /companySwitcherCloseBtn\?\.addEventListener\("click", \(\) => \{\s*if \(ui\.desktopCompanySwitcher\) ui\.desktopCompanySwitcher\.open = false;\s*syncUtilityMenuOverlayState\(\);/);
    assert.match(source, /\.company-switcher-close\s*\{[\s\S]*?z-index:\s*2;[\s\S]*?flex:\s*0 0 28px;[\s\S]*?pointer-events:\s*auto;/);
});
