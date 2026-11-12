"use strict";

const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = process.argv[2];
const targetRoot = process.argv[3];
if (!sourceRoot || !targetRoot) {
  throw new Error("Usage: node scripts/stage-nommm-shopify-self-serve-release.js SOURCE_ROOT TARGET_ROOT");
}

function replaceBlock(target, source, startMarker, endMarker) {
  const sourceStart = source.indexOf(startMarker);
  const sourceEnd = source.indexOf(endMarker, sourceStart);
  const targetStart = target.indexOf(startMarker);
  const targetEnd = target.indexOf(endMarker, targetStart);
  if ([sourceStart, sourceEnd, targetStart, targetEnd].some((value) => value < 0)) {
    throw new Error(`Unable to isolate release block: ${startMarker}`);
  }
  return target.slice(0, targetStart) + source.slice(sourceStart, sourceEnd) + target.slice(targetEnd);
}

const sourcePath = path.join(sourceRoot, "server.js");
const targetPath = path.join(targetRoot, "server.js");
const source = fs.readFileSync(sourcePath, "utf8");
let target = fs.readFileSync(targetPath, "utf8");

target = replaceBlock(
  target,
  source,
  'app.get("/secure/integration-credential"',
  'app.get("/shopify/install"'
);
target = replaceBlock(
  target,
  source,
  "function createIntegrationCredentialRequestToken()",
  "function getShopifyOAuthSecret()"
);

const exportAnchor = /^(\s*)normalizeSubmittedIntegrationCredential,\r?$/m;
if (!exportAnchor.test(target)) throw new Error("Secure integration export anchor is missing.");
target = target.replace(
  exportAnchor,
  (_match, indent) => `${indent}normalizeSubmittedIntegrationCredential,\n${indent}testSubmittedShopifyCredential,\n${indent}normalizeSecureShopifyConfiguration,\n${indent}SHOPIFY_APP_SCOPES,`
);

fs.writeFileSync(targetPath, target, "utf8");
console.log(JSON.stringify({ targetPath, staged: true }));
