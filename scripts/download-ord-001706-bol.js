"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const remote = `
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_PRIVATE_URL||process.env.DATABASE_URL});await c.connect();
try{const r=await c.query(\`select d.file_data from portal_order_documents d join portal_orders o on o.id=d.order_id
where o.order_code='ORD-001706' and o.account_name='ALCONA TRADING LTD' and d.file_name='WMS365_BOL_ORD-001706_2026-10-29_11AM.pdf'\`);
if(r.rowCount!==1)throw Error('Saved BOL identity mismatch');console.log('PDF64:'+Buffer.from(r.rows[0].file_data).toString('base64'));}
finally{await c.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});`;

const remoteEncoded = Buffer.from(remote, "utf8").toString("base64");
const remoteEval = `eval(Buffer.from('${remoteEncoded}','base64').toString())`;
const args = ["--yes", "@railway/cli", "ssh",
  "--project", "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698",
  "--service", "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0",
  "--environment", "e1f5b77e-b935-4f41-9cc5-fccb28edbc57",
  "--", "node", "-e", remoteEval];
const child = spawn("npx.cmd", args, {
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, RAILWAY_CALLER: "skill:use-railway@1.2.3", RAILWAY_AGENT_SESSION: "ord-001706-bol-20261028" },
  windowsHide: true,
  shell: true,
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("close", (code) => {
  if (code !== 0) throw new Error(stderr || `Railway exited ${code}`);
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("PDF64:"));
  if (!marker) throw new Error(`BOL content was not returned. ${stderr}`);
  const outputDir = path.resolve(__dirname, "..", "output", "pdf");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "WMS365_BOL_ORD-001706_2026-10-29_11AM.pdf");
  fs.writeFileSync(outputPath, Buffer.from(marker.slice(6), "base64"));
  console.log(outputPath);
});
