const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SURFACES = ["index.html", "portal.html", "warehouse-actions.html", "mobile-pick.html", "mobile-count.html"];

function auditSurface(fileName) {
    const filePath = path.join(ROOT, fileName);
    const source = fs.readFileSync(filePath, "utf8");
    const buttonMatches = [...source.matchAll(/<button\b[^>]*>/gi)];
    const buttons = buttonMatches.map((match) => match[0]);
    const countOccurrences = (token) => token ? source.split(token).length - 1 : 0;
    const buttonMappings = buttonMatches.map((match) => {
        const button = match[0];
        const id = button.match(/\bid=["']([^"']+)["']/i)?.[1];
        const dataHooks = [...button.matchAll(/\b(data-[\w-]+)(?:\s*=|\s|>)/gi)].map((item) => item[1]);
        const classHooks = (button.match(/\bclass=["']([^"']+)["']/i)?.[1] || "")
            .split(/\s+/)
            .filter(Boolean);
        const reasons = [];
        if (/\btype=["']submit["']/i.test(button)) reasons.push("form-submit");
        if (/\bonclick=/i.test(button)) reasons.push("inline-handler");
        if (id && countOccurrences(id) > 1) reasons.push(`id:${id}`);
        for (const hook of dataHooks) {
            if (countOccurrences(hook) > 1) reasons.push(`data:${hook}`);
        }
        for (const hook of classHooks) {
            if (countOccurrences(hook) > 1 && new RegExp(`(?:querySelector(?:All)?|closest|matches)\\([^\\n]{0,120}\\.${hook}\\b`).test(source)) {
                reasons.push(`class:${hook}`);
            }
        }
        return {
            button,
            line: source.slice(0, match.index).split("\n").length,
            reasons
        };
    });
    const unmappedButtons = buttonMappings.filter((mapping) => mapping.reasons.length === 0);
    const endpoints = [...source.matchAll(/(?:requestJson|requestFile|fetch)\(\s*[`"'](\/[^`"']+)/g)]
        .map((match) => match[1])
        .filter(Boolean);
    return {
        file: fileName,
        bytes: Buffer.byteLength(source),
        buttons: buttons.length,
        mappedButtons: buttons.length - unmappedButtons.length,
        unmappedButtons: unmappedButtons.length,
        unmappedButtonSamples: unmappedButtons.slice(0, 20).map(({ button, line }) => ({ line, button })),
        eventListeners: (source.match(/addEventListener\(/g) || []).length,
        directEndpointReferences: [...new Set(endpoints)].length
    };
}

const surfaces = SURFACES.map(auditSurface);
const result = {
    passed: surfaces.every((surface) => surface.unmappedButtons === 0),
    generatedAt: new Date().toISOString(),
    surfaces,
    totals: surfaces.reduce((totals, surface) => ({
        bytes: totals.bytes + surface.bytes,
        buttons: totals.buttons + surface.buttons,
        mappedButtons: totals.mappedButtons + surface.mappedButtons,
        unmappedButtons: totals.unmappedButtons + surface.unmappedButtons,
        eventListeners: totals.eventListeners + surface.eventListeners,
        directEndpointReferences: totals.directEndpointReferences + surface.directEndpointReferences
    }), { bytes: 0, buttons: 0, mappedButtons: 0, unmappedButtons: 0, eventListeners: 0, directEndpointReferences: 0 })
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
