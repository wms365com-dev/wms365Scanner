const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "docs");

const BLOCKED_PATTERNS = [
    { pattern: /\bmock[-_\s]?ui\b/i, label: "mock UI" },
    { pattern: /\bmock[-_\s]?nav\b/i, label: "mock navigation" },
    { pattern: /\bmockup\b/i, label: "mockup" },
    { pattern: /\bmocked\b/i, label: "mocked screen" },
    { pattern: /screen example/i, label: "screen example" },
    { pattern: /example screen/i, label: "example screen" }
];

function listGuideHtmlFiles() {
    if (!fs.existsSync(DOCS_DIR)) return [];
    return fs.readdirSync(DOCS_DIR)
        .filter((fileName) => /\.html$/i.test(fileName))
        .filter((fileName) => /guide/i.test(fileName))
        .map((fileName) => path.join(DOCS_DIR, fileName));
}

function extractImageSources(html) {
    return [...html.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1/gi)]
        .map((match) => match[2])
        .filter(Boolean);
}

function validateGuide(filePath) {
    const html = fs.readFileSync(filePath, "utf8");
    const relativeFile = path.relative(ROOT, filePath);
    const errors = [];

    for (const blocked of BLOCKED_PATTERNS) {
        if (blocked.pattern.test(html)) {
            errors.push(`${relativeFile} contains ${blocked.label}. Customer guides must use actual WMS365 system screenshots.`);
        }
    }

    for (const source of extractImageSources(html)) {
        if (/^(https?:)?\/\//i.test(source) || source.startsWith("data:")) continue;
        const resolved = path.resolve(path.dirname(filePath), source);
        if (!resolved.startsWith(DOCS_DIR)) {
            errors.push(`${relativeFile} references image outside docs/: ${source}`);
            continue;
        }
        if (!fs.existsSync(resolved)) {
            errors.push(`${relativeFile} references missing image: ${source}`);
        }
    }

    return errors;
}

const errors = listGuideHtmlFiles().flatMap(validateGuide);
if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
}

console.log("Guide screenshot validation passed. Customer guides use actual system image assets.");
