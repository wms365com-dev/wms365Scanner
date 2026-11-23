const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const DEFAULT_PREFIX = "wms365-backups/production/";
const BACKUP_MAGIC = Buffer.from("WMS365BKP1");

function requireEnv(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizePrefix(value = DEFAULT_PREFIX) {
  const prefix = String(value || DEFAULT_PREFIX).trim().replace(/^\/+/, "").replace(/\/*$/, "/");
  if (!prefix.startsWith("wms365-backups/") || prefix.includes("..") || prefix === "wms365-backups/") {
    throw new Error("BACKUP_S3_PREFIX must be a dedicated child of wms365-backups/");
  }
  return prefix;
}

function parsePositiveInt(value, fallback, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function loadConfig(env = process.env) {
  const encryptionKey = Buffer.from(requireEnv(env, "BACKUP_ENCRYPTION_KEY_B64"), "base64");
  if (encryptionKey.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes");
  const endpoint = requireEnv(env, "BACKUP_S3_ENDPOINT");
  if (new URL(endpoint).protocol !== "https:") throw new Error("BACKUP_S3_ENDPOINT must use HTTPS");
  const retentionDays = parsePositiveInt(env.BACKUP_RETENTION_DAYS, 30, "BACKUP_RETENTION_DAYS");
  if (retentionDays < 30) throw new Error("BACKUP_RETENTION_DAYS must be at least 30");
  const expectedBucketOwner = String(env.BACKUP_EXPECTED_BUCKET_OWNER || "").trim();
  if (expectedBucketOwner && !/^\d{12}$/.test(expectedBucketOwner)) throw new Error("BACKUP_EXPECTED_BUCKET_OWNER must be a 12-digit AWS account ID");
  const endpointHost = new URL(endpoint).hostname;
  const isAmazonS3 = endpointHost === "amazonaws.com" || endpointHost.endsWith(".amazonaws.com");
  if (isAmazonS3 && !expectedBucketOwner) {
    throw new Error("BACKUP_EXPECTED_BUCKET_OWNER is required for Amazon S3");
  }
  const region = String(env.BACKUP_S3_REGION || "auto").trim();
  if (isAmazonS3 && region === "auto") throw new Error("BACKUP_S3_REGION is required for Amazon S3");
  const volumePaths = String(env.BACKUP_VOLUME_PATHS || "").split(",").map((v) => v.trim()).filter(Boolean);
  for (const volumePath of volumePaths) {
    if (!path.isAbsolute(volumePath) || path.parse(volumePath).root === volumePath) {
      throw new Error("Every BACKUP_VOLUME_PATHS entry must be an absolute non-root path");
    }
  }
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    encryptionKey,
    endpoint,
    region,
    bucket: requireEnv(env, "BACKUP_S3_BUCKET"),
    accessKeyId: requireEnv(env, "BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv(env, "BACKUP_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: String(env.BACKUP_S3_FORCE_PATH_STYLE || "false").toLowerCase() === "true",
    prefix: normalizePrefix(env.BACKUP_S3_PREFIX),
    retentionDays,
    expectedBucketOwner: expectedBucketOwner || undefined,
    codeRoot: path.resolve(env.BACKUP_CODE_ROOT || "/workspace"),
    volumePaths,
    alertWebhookUrl: String(env.BACKUP_ALERT_WEBHOOK_URL || "").trim()
  };
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function relativeBackupKey(prefix, stamp, id) {
  return `${prefix}daily/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/wms365-${stamp}-${id}.tar.enc`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function encryptFile(inputPath, outputPath, key, randomBytes = crypto.randomBytes) {
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  output.write(Buffer.concat([BACKUP_MAGIC, iv]));
  await pipeline(fs.createReadStream(inputPath), cipher, output);
  await fs.promises.appendFile(outputPath, cipher.getAuthTag());
}

async function decryptFile(inputPath, outputPath, key) {
  const stat = await fs.promises.stat(inputPath);
  const headerLength = BACKUP_MAGIC.length + 12;
  if (stat.size < headerLength + 16) throw new Error("Encrypted backup is truncated");
  const handle = await fs.promises.open(inputPath, "r");
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - tag.length);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("Encrypted backup header is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(BACKUP_MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(
    fs.createReadStream(inputPath, { start: header.length, end: stat.size - tag.length - 1 }),
    decipher,
    fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
  );
}

function safeError(error) {
  const message = String(error && error.message || error || "Unknown backup failure");
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(secret|password|token|key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}

function assertRestoreTarget(sourceUrl, targetUrl) {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  if (source.hostname === target.hostname && (source.port || "5432") === (target.port || "5432")) {
    throw new Error("Restore verification target must be on a separate database server");
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!/(restore|verify|test|scratch)/i.test(databaseName)) {
    throw new Error("Restore verification database name must contain restore, verify, test, or scratch");
  }
}

function postgresEnv(connectionString, baseEnv = process.env) {
  const url = new URL(connectionString);
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("PostgreSQL connection URL is invalid");
  const sslMode = url.searchParams.get("sslmode");
  return {
    ...baseEnv,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ...(sslMode ? { PGSSLMODE: sslMode } : {})
  };
}

module.exports = {
  assertRestoreTarget, decryptFile, encryptFile, loadConfig,
  normalizePrefix, postgresEnv, relativeBackupKey, safeError, sha256File, utcStamp
};
