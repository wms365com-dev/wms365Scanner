"use strict";
const crypto = require("crypto");
const fs = require("fs");
if (crypto.createPublicKey(fs.readFileSync(process.argv[2])).asymmetricKeyType !== "ed25519") throw new Error("Ed25519 publisher public key required.");
