const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { GetObjectCommand, HeadObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { assertRestoreTarget, decryptFile, loadConfig, postgresEnv, safeError, sha256File } = require("./lib");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${safeError(stderr)}`)));
  });
}

async function main() {
  let workDir;
  try {
    if (process.env.ALLOW_RESTORE_VERIFICATION !== "true") throw new Error("ALLOW_RESTORE_VERIFICATION=true is required");
    const config = loadConfig();
    const targetUrl = String(process.env.RESTORE_VERIFY_DATABASE_URL || "").trim();
    if (!targetUrl) throw new Error("RESTORE_VERIFY_DATABASE_URL is required");
    assertRestoreTarget(config.databaseUrl, targetUrl);
    const key = String(process.env.BACKUP_OBJECT_KEY || "").trim();
    if (!key.startsWith(config.prefix) || !key.endsWith(".tar.enc")) throw new Error("BACKUP_OBJECT_KEY must be an encrypted object inside BACKUP_S3_PREFIX");
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wms365-restore-"));
    const encrypted = path.join(workDir, "backup.tar.enc");
    const archive = path.join(workDir, "backup.tar");
    const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
    const bucketArgs = { Bucket: config.bucket, ...(config.expectedBucketOwner ? { ExpectedBucketOwner: config.expectedBucketOwner } : {}) };
    const head = await client.send(new HeadObjectCommand({ ...bucketArgs, Key: key, ChecksumMode: "ENABLED" }));
    const response = await client.send(new GetObjectCommand({ ...bucketArgs, Key: key }));
    await pipeline(response.Body, fs.createWriteStream(encrypted, { flags: "wx", mode: 0o600 }));
    const checksum = await sha256File(encrypted);
    const encodedChecksum = Buffer.from(checksum, "hex").toString("base64");
    if (Number(head.ContentLength) !== (await fs.promises.stat(encrypted)).size ||
        checksum !== head.Metadata?.["wms365-sha256"] || head.ChecksumSHA256 !== encodedChecksum) {
      throw new Error("Downloaded ciphertext checksum does not match the remote object");
    }
    await decryptFile(encrypted, archive, config.encryptionKey);
    await run("tar", ["-xf", archive, "-C", workDir]);
    const dump = path.join(workDir, "database", "wms365.dump");
    const targetEnv = postgresEnv(targetUrl);
    await run("pg_restore", ["--dbname", targetEnv.PGDATABASE, "--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", dump], { env: targetEnv });
    await run("psql", ["-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"], { env: targetEnv });
    process.stdout.write(`${JSON.stringify({ ok: true, key, verifiedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    process.stderr.write(`Restore verification failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) main();
