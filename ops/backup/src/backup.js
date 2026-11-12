const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");
const {
  GetBucketVersioningCommand, GetObjectLockConfigurationCommand, HeadObjectCommand,
  PutObjectCommand, S3Client
} = require("@aws-sdk/client-s3");
const {
  encryptFile, loadConfig, postgresEnv, relativeBackupKey, safeError, sha256File, utcStamp
} = require("./lib");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${safeError(stderr)}`)));
  });
}

async function copyPath(source, destination) {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to archive symbolic link: ${source}`);
  await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

async function inventoryFiles(root, current = root) {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to checksum symbolic link: ${fullPath}`);
    if (entry.isDirectory()) results.push(...await inventoryFiles(root, fullPath));
    if (entry.isFile()) results.push({
      path: path.relative(root, fullPath).split(path.sep).join("/"),
      bytes: (await fs.promises.stat(fullPath)).size,
      sha256: await sha256File(fullPath)
    });
  }
  return results;
}

async function buildBackup(config, workDir, now) {
  const contentDir = path.join(workDir, "content");
  await fs.promises.mkdir(path.join(contentDir, "database"), { recursive: true });
  const dumpPath = path.join(contentDir, "database", "wms365.dump");
  await run("pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-acl", `--file=${dumpPath}`], { env: postgresEnv(config.databaseUrl) });
  await run("pg_restore", ["--list", dumpPath]);

  const codeDir = path.join(contentDir, "release");
  await fs.promises.mkdir(codeDir, { recursive: true });
  const requiredSourceFiles = ["server.js", "package.json", "package-lock.json", "railway.json"];
  for (const relative of requiredSourceFiles) {
    if (!fs.existsSync(path.join(config.codeRoot, relative))) {
      throw new Error(`Required deployed source is missing: ${relative}`);
    }
  }
  await copyPath(config.codeRoot, path.join(codeDir, "source"));

  const volumesDir = path.join(contentDir, "persistent-volumes");
  for (const [index, volumePath] of config.volumePaths.entries()) {
    if (!fs.existsSync(volumePath)) throw new Error(`Configured persistent path is missing: ${volumePath}`);
    await fs.promises.mkdir(volumesDir, { recursive: true });
    await copyPath(volumePath, path.join(volumesDir, `volume-${index + 1}`));
  }

  const manifest = {
    format: "wms365-backup-v1",
    createdAt: now.toISOString(),
    database: { format: "pg_dump-custom", verifiedWith: "pg_restore --list" },
    documents: "Stored PostgreSQL bytea/text document records are included in the logical dump.",
    persistentVolumes: config.volumePaths.map((_, index) => `persistent-volumes/volume-${index + 1}`),
    release: {
      gitCommit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "unknown",
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || "unknown",
      serviceId: process.env.RAILWAY_SERVICE_ID || "unknown",
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || "unknown",
      paths: ["release/source"],
      requiredSourceFiles
    },
    files: await inventoryFiles(contentDir)
  };
  await fs.promises.writeFile(path.join(contentDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const archivePath = path.join(workDir, "wms365-backup.tar");
  await run("tar", ["-cf", archivePath, "-C", contentDir, "."]);
  return { archivePath, manifest };
}

function bucketArgs(config) {
  return { Bucket: config.bucket, ...(config.expectedBucketOwner ? { ExpectedBucketOwner: config.expectedBucketOwner } : {}) };
}

async function verifyImmutableBucket(client, config) {
  const versioning = await client.send(new GetBucketVersioningCommand(bucketArgs(config)));
  if (versioning.Status !== "Enabled") throw new Error("Backup bucket versioning must be enabled");
  const lock = await client.send(new GetObjectLockConfigurationCommand(bucketArgs(config)));
  if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") {
    throw new Error("Backup bucket Object Lock must be enabled");
  }
}

async function uploadAndVerify(client, config, encryptedPath, now, id, clock = () => new Date()) {
  const checksum = await sha256File(encryptedPath);
  const size = (await fs.promises.stat(encryptedPath)).size;
  const stamp = utcStamp(now);
  const dailyKey = relativeBackupKey(config.prefix, stamp, id);
  const retainUntil = new Date(Math.max(clock().getTime(), now.getTime()) + config.retentionDays * 86400000);
  const expectedChecksum = Buffer.from(checksum, "hex").toString("base64");
  await client.send(new PutObjectCommand({
    ...bucketArgs(config), Key: dailyKey, Body: fs.createReadStream(encryptedPath), ContentLength: size,
    ContentType: "application/octet-stream", ChecksumAlgorithm: "SHA256", ChecksumSHA256: expectedChecksum,
    ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: retainUntil,
    Metadata: { "wms365-sha256": checksum, "wms365-format": "wms365-backup-v1" }
  }));
  const head = await client.send(new HeadObjectCommand({ ...bucketArgs(config), Key: dailyKey, ChecksumMode: "ENABLED" }));
  if (Number(head.ContentLength) !== size || head.Metadata?.["wms365-sha256"] !== checksum ||
      head.ChecksumSHA256 !== expectedChecksum || head.ObjectLockMode !== "COMPLIANCE" ||
      new Date(head.ObjectLockRetainUntilDate).getTime() < retainUntil.getTime()) {
    throw new Error("Uploaded backup verification failed");
  }
  const attestation = {
    format: "wms365-backup-attestation-v1", createdAt: now.toISOString(), keys: [dailyKey],
    bytes: size, ciphertextSha256: checksum, lockedUntil: retainUntil.toISOString()
  };
  const body = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);
  const attestationChecksum = crypto.createHash("sha256").update(body).digest("base64");
  await client.send(new PutObjectCommand({
    ...bucketArgs(config), Key: `${dailyKey}.json`, Body: body, ContentLength: body.length,
    ContentType: "application/json", ChecksumAlgorithm: "SHA256", ChecksumSHA256: attestationChecksum,
    ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: retainUntil
  }));
  const attestationHead = await client.send(new HeadObjectCommand({
    ...bucketArgs(config), Key: `${dailyKey}.json`, ChecksumMode: "ENABLED"
  }));
  if (Number(attestationHead.ContentLength) !== body.length ||
      attestationHead.ChecksumSHA256 !== attestationChecksum ||
      attestationHead.ObjectLockMode !== "COMPLIANCE" ||
      new Date(attestationHead.ObjectLockRetainUntilDate).getTime() < retainUntil.getTime()) {
    throw new Error("Backup attestation verification failed");
  }
  return attestation;
}

async function notify(url, status, detail) {
  if (!url) return;
  await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "wms365-backup", status, detail: safeError(detail), at: new Date().toISOString() })
  }).then((response) => { if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}`); });
}

async function main() {
  let config;
  let workDir;
  try {
    config = loadConfig();
    const client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    });
    await verifyImmutableBucket(client, config);
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wms365-backup-"));
    const now = new Date();
    const id = crypto.randomBytes(6).toString("hex");
    const { archivePath } = await buildBackup(config, workDir, now);
    const encryptedPath = `${archivePath}.enc`;
    await encryptFile(archivePath, encryptedPath, config.encryptionKey);
    await fs.promises.rm(archivePath, { force: true });
    const attestation = await uploadAndVerify(client, config, encryptedPath, now, id);
    await notify(config.alertWebhookUrl, "success", `verified immutable backup ${attestation.keys[0]}`);
    process.stdout.write(`${JSON.stringify({ ok: true, keys: attestation.keys, bytes: attestation.bytes, ciphertextSha256: attestation.ciphertextSha256, lockedUntil: attestation.lockedUntil })}\n`);
  } catch (error) {
    try { await notify(config?.alertWebhookUrl, "failure", error); } catch (notifyError) { process.stderr.write(`Alert failed: ${safeError(notifyError)}\n`); }
    process.stderr.write(`Backup failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { buildBackup, uploadAndVerify, verifyImmutableBucket };
