const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const {
  assertRestoreTarget, decryptFile, encryptFile, loadConfig,
  normalizePrefix, postgresEnv, relativeBackupKey, safeError
} = require("../src/lib");

const originalLoad = Module._load;
let backup;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "@aws-sdk/client-s3") {
      return Object.fromEntries([
        "GetBucketVersioningCommand", "GetObjectLockConfigurationCommand", "HeadObjectCommand",
        "PutObjectCommand", "S3Client"
      ].map((name) => [name, class {
        constructor(input) { this.kind = name; this.input = input; }
      }]));
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  backup = require("../src/backup");
} finally {
  Module._load = originalLoad;
}

test("dedicated prefix guard blocks broad or traversing prefixes", () => {
  assert.equal(normalizePrefix(""), "wms365-backups/production/");
  assert.throws(() => normalizePrefix("/"), /dedicated child/);
  assert.throws(() => normalizePrefix("wms365-backups/"), /dedicated child/);
  assert.throws(() => normalizePrefix("wms365-backups/../other"), /dedicated child/);
  assert.equal(normalizePrefix("/wms365-backups/production"), "wms365-backups/production/");
});

test("backup keys are scoped to immutable daily objects", () => {
  assert.equal(
    relativeBackupKey("wms365-backups/production/", "20260926T010203Z", "abcdef123456"),
    "wms365-backups/production/daily/2026/09/wms365-20260926T010203Z-abcdef123456.tar.enc"
  );
});

test("bucket preflight fails closed unless versioning and Object Lock are enabled", async () => {
  const config = { bucket: "wms365-dr", expectedBucketOwner: "123456789012" };
  const client = (version, locked) => ({ send: async (command) => {
    assert.equal(command.input.ExpectedBucketOwner, config.expectedBucketOwner);
    if (command.kind === "GetBucketVersioningCommand") return { Status: version };
    if (command.kind === "GetObjectLockConfigurationCommand") return { ObjectLockConfiguration: { ObjectLockEnabled: locked } };
    throw new Error("Unexpected command");
  } });
  await assert.rejects(() => backup.verifyImmutableBucket(client("Suspended", "Enabled"), config), /versioning/);
  await assert.rejects(() => backup.verifyImmutableBucket(client("Enabled", "Disabled"), config), /Object Lock/);
  await assert.doesNotReject(() => backup.verifyImmutableBucket(client("Enabled", "Enabled"), config));
});

test("upload verifies remote checksum and 30-day compliance lock on archive and attestation", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wms365-upload-test-"));
  try {
    const file = path.join(dir, "archive.enc");
    await fs.promises.writeFile(file, "encrypted backup sample");
    const now = new Date("2026-09-26T03:00:00Z");
    const config = { bucket: "wms365-dr", prefix: "wms365-backups/production/", retentionDays: 30 };
    const uploads = new Map();
    const client = { send: async (command) => {
      if (command.kind === "PutObjectCommand") {
        uploads.set(command.input.Key, command.input);
        return {};
      }
      if (command.kind === "HeadObjectCommand") {
        const put = uploads.get(command.input.Key);
        assert.ok(put);
        return {
          ContentLength: put.ContentLength, Metadata: put.Metadata,
          ChecksumSHA256: put.ChecksumSHA256, ObjectLockMode: put.ObjectLockMode,
          ObjectLockRetainUntilDate: put.ObjectLockRetainUntilDate
        };
      }
      throw new Error(`Unexpected command: ${command.kind}`);
    } };
    const result = await backup.uploadAndVerify(client, config, file, now, "abcdef123456", () => now);
    assert.equal(result.keys.length, 1);
    assert.equal(uploads.size, 2);
    for (const put of uploads.values()) {
      assert.equal(put.ObjectLockMode, "COMPLIANCE");
      assert.equal(put.ChecksumAlgorithm, "SHA256");
      assert.equal(put.ObjectLockRetainUntilDate.toISOString(), "2026-10-26T03:00:00.000Z");
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("AES-256-GCM round trips and rejects tampering", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wms365-crypto-test-"));
  try {
    const input = path.join(dir, "input");
    const encrypted = path.join(dir, "encrypted");
    const output = path.join(dir, "output");
    await fs.promises.writeFile(input, "backup payload");
    const key = Buffer.alloc(32, 7);
    await encryptFile(input, encrypted, key, () => Buffer.alloc(12, 3));
    await decryptFile(encrypted, output, key);
    assert.equal(await fs.promises.readFile(output, "utf8"), "backup payload");
    const bytes = await fs.promises.readFile(encrypted);
    bytes[25] ^= 1;
    await fs.promises.writeFile(encrypted, bytes);
    await assert.rejects(() => decryptFile(encrypted, `${output}.tampered`, key));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("configuration requires all secrets and validates the encryption key", () => {
  const env = {
    DATABASE_URL: "postgres://db.example/wms365", BACKUP_ENCRYPTION_KEY_B64: Buffer.alloc(32).toString("base64"),
    BACKUP_S3_ENDPOINT: "https://s3.example", BACKUP_S3_BUCKET: "backup",
    BACKUP_S3_ACCESS_KEY_ID: "id", BACKUP_S3_SECRET_ACCESS_KEY: "secret"
  };
  assert.equal(loadConfig(env).retentionDays, 30);
  assert.throws(() => loadConfig({ ...env, BACKUP_RETENTION_DAYS: "29" }), /at least 30/);
  assert.throws(() => loadConfig({ ...env, BACKUP_EXPECTED_BUCKET_OWNER: "wrong" }), /12-digit/);
  assert.throws(() => loadConfig({ ...env, BACKUP_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com" }), /BACKUP_EXPECTED_BUCKET_OWNER/);
  assert.throws(() => loadConfig({ ...env, BACKUP_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com", BACKUP_EXPECTED_BUCKET_OWNER: "123456789012" }), /BACKUP_S3_REGION/);
  assert.equal(loadConfig({ ...env, BACKUP_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com", BACKUP_EXPECTED_BUCKET_OWNER: "123456789012", BACKUP_S3_REGION: "us-east-1" }).expectedBucketOwner, "123456789012");
  assert.throws(() => loadConfig({ ...env, BACKUP_ENCRYPTION_KEY_B64: "bad" }), /32 bytes/);
  assert.throws(() => loadConfig({ ...env, BACKUP_S3_ENDPOINT: "http://s3.example" }), /HTTPS/);
});

test("restore target guard rejects production and requires an obvious scratch database", () => {
  const source = "postgres://u:p@db.example:5432/wms365";
  assert.throws(() => assertRestoreTarget(source, source), /separate database server/);
  assert.throws(() => assertRestoreTarget(source, "postgres://u:p@db.example:5432/wms365_restore_verify"), /separate database server/);
  assert.throws(() => assertRestoreTarget(source, "postgres://u:p@other.example/customer"), /database name/);
  assert.doesNotThrow(() => assertRestoreTarget(source, "postgres://u:p@other.example/wms365_restore_verify"));
});

test("errors redact connection strings and secret-like values", () => {
  const safe = safeError("failed postgres://user:pass@host/db?ssl=true token=abc123");
  assert.doesNotMatch(safe, /user:pass|abc123/);
});

test("PostgreSQL credentials are converted to environment variables, not command arguments", () => {
  const env = postgresEnv("postgresql://backup%40user:p%40ss@db.internal:5433/wms_restore?sslmode=require", {});
  assert.deepEqual(env, {
    PGHOST: "db.internal", PGPORT: "5433", PGUSER: "backup@user", PGPASSWORD: "p@ss",
    PGDATABASE: "wms_restore", PGSSLMODE: "require"
  });
});
