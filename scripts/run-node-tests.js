const { readdirSync } = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const testFiles = readdirSync(root)
    .filter((name) => name.endsWith(".spec.js")
        && !name.endsWith(".visual.spec.js")
        && name !== "audit-billing-finance.spec.js")
    .sort();

if (!testFiles.length) {
    console.error("No Node test specifications were found.");
    process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: root,
    stdio: "inherit"
});

process.exit(result.status ?? 1);
