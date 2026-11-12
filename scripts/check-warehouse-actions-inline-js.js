"use strict";

const fs = require("node:fs");

for (const fileName of ["warehouse-actions.html", "mobile-receive.html", "mobile-pick.html", "mobile-ship-pdf.html"]) {
    const html = fs.readFileSync(fileName, "utf8");
    const scriptPattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scriptPattern)) {
        if (match[1].trim()) Function(match[1]);
    }
    console.log(`${fileName} inline scripts parse`);
}
