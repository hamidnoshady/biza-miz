import { describe, expect, it } from "vitest";
import {
  backupPassphrase,
  backupStaleAfterMs,
  cloudKeyFor,
  computeBackupAlert,
  decryptBackup,
  DEFAULT_BACKUP_CONFIG,
  dumpDatabaseUrl,
  encryptBackup,
  isBackupDue,
  isBackupStale,
  isEncryptedBackup,
  isFailedRunRetryDue,
  isPlainArtifactName,
  latestSlotBefore,
  LOCAL_RETRY_MS,
  artifactRunToken,
  artifactScopeTag,
  isLogicalArtifactName,
  isPhysicalArtifactName,
  makeArtifactName,
  parseArtifactName,
  parseArtifactTimestamp,
  reserveArtifactName,
  selectPrunable,
  selectPrunableInScope,
  toWallClock,
  validateBackupConfig,
  type BackupAlertInput,
  type BackupConfig,
} from "./backup";

const TEHRAN = "Asia/Tehran"; // UTC+03:30 year-round (no DST since 2022)

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 14,
    cloud: { ...DEFAULT_BACKUP_CONFIG.cloud },
    ...overrides,
  };
}

describe("validateBackupConfig", () => {
  it("accepts a minimal local-only config", () => {
    const v = validateBackupConfig(validBody());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.enabled).toBe(true);
      expect(v.config.cloud.enabled).toBe(false);
    }
  });

  it("rejects non-objects and bad fields", () => {
    expect(validateBackupConfig(null)).toEqual({ ok: false, error: "not_an_object" });
    expect(validateBackupConfig(validBody({ intervalHours: 5 }))).toEqual({
      ok: false,
      error: "invalid_interval",
    });
    expect(validateBackupConfig(validBody({ anchorTime: "25:00" }))).toEqual({
      ok: false,
      error: "invalid_anchor_time",
    });
    expect(validateBackupConfig(validBody({ localRetention: 0 }))).toEqual({
      ok: false,
      error: "invalid_local_retention",
    });
  });

  it("defaults an absent backup directory to empty and round-trips a supplied one", () => {
    // Empty means "use BACKUP_DIR / the built-in default", which is what every
    // install that predates the desktop app stores — so an absent field must
    // not become undefined or a literal path.
    const absent = validateBackupConfig(validBody());
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.config.directory).toBe("");

    const supplied = validateBackupConfig(validBody({ directory: "  D:\\pos-backups  " }));
    expect(supplied.ok).toBe(true);
    if (supplied.ok) expect(supplied.config.directory).toBe("D:\\pos-backups");

    expect(validateBackupConfig(validBody({ directory: 42 }))).toEqual({
      ok: false,
      error: "invalid_directory",
    });
  });

  it("requires endpoint/bucket/credentials/passphrase when cloud is enabled", () => {
    const cloud = {
      enabled: true,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "backups",
      prefix: "pos-backups/",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      passphrase: "correct horse battery",
      retention: 30,
    };
    expect(validateBackupConfig(validBody({ cloud })).ok).toBe(true);
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, endpoint: "ftp://x" } }))).toEqual({
      ok: false,
      error: "invalid_cloud_endpoint",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, bucket: "" } }))).toEqual({
      ok: false,
      error: "missing_cloud_bucket",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, secretAccessKey: "" } }))).toEqual({
      ok: false,
      error: "missing_cloud_credentials",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, passphrase: "short" } }))).toEqual({
      ok: false,
      error: "weak_passphrase",
    });
  });

  it("refuses to enable cloud with no passphrase at all", () => {
    // Not merely a weak key: an empty one derives the AES key via
    // scryptSync("", salt) — public knowledge — so the uploaded artifact is
    // effectively plaintext to whoever obtains it. Neither the top-level nor
    // the legacy cloud passphrase being set must fail closed.
    const cloud = {
      enabled: true,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "backups",
      prefix: "pos-backups/",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      passphrase: "",
      retention: 30,
    };
    expect(validateBackupConfig(validBody({ cloud }))).toEqual({
      ok: false,
      error: "passphrase_required",
    });
    // Either slot satisfies it — the top-level one is the modern home.
    expect(validateBackupConfig(validBody({ cloud, passphrase: "correct horse battery" })).ok).toBe(true);
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, passphrase: "correct horse" } })).ok).toBe(true);
  });

  it("still saves a local-only config with no passphrase", () => {
    // encryptLocal defaults to on and documents a plaintext fallback with a
    // visible warning (Phase 24 §5), so requiring a passphrase here would lock
    // every pre-existing install out of its own settings page.
    const v = validateBackupConfig(validBody({ encryptLocal: true, passphrase: "" }));
    expect(v.ok).toBe(true);
  });

  it("normalizes cloud prefix and endpoint", () => {
    const v = validateBackupConfig(
      validBody({
        cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, prefix: "my-cafe", endpoint: "https://s3.example.com//" },
      }),
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.cloud.prefix).toBe("my-cafe/");
      expect(v.config.cloud.endpoint).toBe("https://s3.example.com");
    }
  });
});

describe("artifact naming", () => {
  it("stamps names in UTC and parses them back", () => {
    const name = makeArtifactName(new Date("2026-07-21T03:30:05.123Z"));
    expect(name).toBe("pos-backup-20260721-033005.dump");
    expect(parseArtifactTimestamp(name)).toBe("2026-07-21T03:30:05Z");
    expect(parseArtifactTimestamp(`${name}.enc`)).toBe("2026-07-21T03:30:05Z");
    expect(parseArtifactTimestamp("pos-backups/pos-backup-20260721-033005.dump.enc")).toBe(
      "2026-07-21T03:30:05Z",
    );
  });

  it("rejects names that aren't artifacts (or fake dates)", () => {
    expect(parseArtifactTimestamp("notes.txt")).toBeNull();
    expect(parseArtifactTimestamp("pos-backup-20261341-033005.dump")).toBeNull();
  });

  it("builds cloud keys under the prefix with .enc", () => {
    expect(cloudKeyFor("pos-backups/", "pos-backup-20260721-033005.dump")).toBe(
      "pos-backups/pos-backup-20260721-033005.dump.enc",
    );
    expect(cloudKeyFor("", "a.dump")).toBe("a.dump.enc");
  });

  it("does not double-append .enc to an already-encrypted local artifact", () => {
    // Phase 24 §5's sharpest trap: local artifacts are now encrypted before
    // upload, so a blind append would ship `.dump.enc.enc`.
    expect(cloudKeyFor("pos/", "file.dump")).toBe("pos/file.dump.enc");
    expect(cloudKeyFor("pos/", "file.dump.enc")).toBe("pos/file.dump.enc");
  });
});

describe("scoped artifact names (issue #807)", () => {
  const businessId = "0B6E5A2C-1111-4222-8333-444455556666";
  const tag = artifactScopeTag(businessId); // lowercased, separators stripped
  const at = new Date("2026-07-21T03:30:05.123Z");
  const runId = "abcdef01-2345-4678-9abc-def012345678";

  it("encodes scope, run id, format and encryption, and parses them all back", () => {
    const name = makeArtifactName(at, { scope: businessId, runId, format: "sql", encrypted: true });
    expect(name).toBe(`pos-backup-${tag}-20260721-033005-abcdef01.sql.enc`);
    expect(parseArtifactName(name)).toEqual({
      name,
      scope: tag,
      timestamp: "2026-07-21T03:30:05Z",
      runId: "abcdef01",
      format: "sql",
      encrypted: true,
    });
    expect(isLogicalArtifactName(name)).toBe(true);
    expect(isPhysicalArtifactName(name)).toBe(false);
  });

  it("parses a pre-#807 name as legacy: no scope, no run id", () => {
    const parsed = parseArtifactName("pos-backup-20260721-033005.dump");
    expect(parsed).toMatchObject({ scope: null, runId: null, format: "dump", encrypted: false });
    expect(isPhysicalArtifactName("pos-backup-20260721-033005.dump")).toBe(true);
  });

  it("refuses a name whose scope tag is too long or whose run token is not hex", () => {
    expect(parseArtifactName("pos-backup-this-tag-is-way-too-long-20260721-033005-abcdef01.dump")).toBeNull();
    expect(parseArtifactName("pos-backup-abcdef01-20260721-033005-ABCDEF01.dump")).toBeNull();
    expect(parseArtifactName("pos-backup-abcdef01-20260721-033005.sql.exe")).toBeNull();
  });

  it("derives the same tag in every process, from the business id alone", () => {
    expect(artifactScopeTag(businessId)).toBe("0b6e5a2c11114222");
    expect(artifactScopeTag("0b6e5a2c11114222")).toBe("0b6e5a2c11114222");
    expect(artifactScopeTag("---")).toBe("default");
    expect(artifactRunToken(runId)).toBe("abcdef01");
    expect(artifactRunToken("zzz")).toBe("zzz00000");
  });

  it("makes two runs in the same second collide-free by construction", () => {
    const a = makeArtifactName(at, { scope: businessId, runId: "11111111-2222-3333-4444-555555555555" });
    const b = makeArtifactName(at, { scope: businessId, runId: "99999999-8888-7777-6666-555555555555" });
    expect(a).not.toBe(b);
    expect(parseArtifactName(a)?.timestamp).toBe(parseArtifactName(b)?.timestamp);
  });

  it("reserves a name by retrying, and gives up rather than overwriting", async () => {
    const taken = new Set(["pos-backup-x-20260721-033005-11111111.dump"]);
    let attempt = 0;
    const free = await reserveArtifactName(
      "/tmp",
      () => ["pos-backup-x-20260721-033005-11111111.dump", "pos-backup-x-20260721-033005-22222222.dump"][
        Math.min(attempt++, 1)
      ],
      async (filePath) => taken.has(filePath.split("/").at(-1) ?? ""),
    );
    expect(free).toBe("pos-backup-x-20260721-033005-22222222.dump");
    await expect(
      reserveArtifactName("/tmp", () => "pos-backup-x-20260721-033005-11111111.dump", async () => true),
    ).rejects.toThrow("artifact_name_collision");
  });
});

describe("retention never crosses scopes (issue #807)", () => {
  const scopeA = "aaaa1111-2222-4333-8444-555555555555";
  const scopeB = "bbbb1111-2222-4333-8444-555555555555";
  const tagA = artifactScopeTag(scopeA);
  const tagB = artifactScopeTag(scopeB);
  const name = (scope: string, day: number, run: string) =>
    `pos-backup-${scope}-202607${String(day).padStart(2, "0")}-033005-${run}.dump`;
  const legacy = "pos-backup-20260601-033005.dump";

  const names = [
    name(tagA, 1, "11111111"),
    name(tagA, 2, "22222222"),
    name(tagA, 3, "33333333"),
    name(tagB, 1, "44444444"),
    name(tagB, 2, "55555555"),
    legacy,
    "notes.txt",
  ];

  it("considers only this scope's artifacts, newest-first beyond the keep count", () => {
    const pruned = selectPrunableInScope(names, 1, scopeA);
    expect(pruned).toEqual([name(tagA, 2, "22222222"), name(tagA, 1, "11111111")]);
    // The other tenant's files are not candidates, no matter how many there are.
    expect(pruned.some((n) => n.includes(tagB))).toBe(false);
    expect(pruned).not.toContain(legacy);
  });

  it("adopts a legacy unscoped name only when the caller asks (a site install)…", () => {
    const adopted = selectPrunableInScope([...names, "pos-backup-20260602-033005.dump"], 0, scopeA, {
      adoptUnscoped: true,
    });
    expect(adopted).toContain(legacy);
    expect(adopted).toContain("pos-backup-20260602-033005.dump");
    expect(adopted.some((n) => n.includes(tagB))).toBe(false);
  });

  it("…and never on a central scope, where every artifact is tagged", () => {
    const pruned = selectPrunableInScope([legacy], 0, scopeA);
    expect(pruned).toEqual([]);
  });

  it("keeps everything when the retention count still covers it", () => {
    expect(selectPrunableInScope(names, 5, scopeA)).toEqual([]);
    expect(selectPrunableInScope([], 0, scopeA)).toEqual([]);
  });
});

describe("backupPassphrase", () => {
  it("resolves top-level, then the legacy cloud slot, then the environment", () => {
    const originalEnv = process.env.BACKUP_PASSPHRASE;
    try {
      process.env.BACKUP_PASSPHRASE = "env-pass";

      const conf: BackupConfig = { ...DEFAULT_BACKUP_CONFIG };
      expect(backupPassphrase(conf)).toBe("env-pass");

      conf.cloud = { ...conf.cloud, passphrase: "cloud-pass" };
      expect(backupPassphrase(conf)).toBe("cloud-pass");

      conf.passphrase = "top-pass";
      expect(backupPassphrase(conf)).toBe("top-pass");
    } finally {
      if (originalEnv === undefined) delete process.env.BACKUP_PASSPHRASE;
      else process.env.BACKUP_PASSPHRASE = originalEnv;
    }
  });

  it("is empty when nothing is configured — the caller must fail closed", () => {
    const originalEnv = process.env.BACKUP_PASSPHRASE;
    try {
      delete process.env.BACKUP_PASSPHRASE;
      expect(backupPassphrase({ ...DEFAULT_BACKUP_CONFIG })).toBe("");
    } finally {
      if (originalEnv !== undefined) process.env.BACKUP_PASSPHRASE = originalEnv;
    }
  });
});

describe("schedule slots (wall clock)", () => {
  it("converts instants to Tehran wall clock (+03:30)", () => {
    expect(toWallClock(new Date("2026-07-21T00:00:00Z"), TEHRAN)).toEqual({
      date: "2026-07-21",
      minutes: 3 * 60 + 30,
    });
    // 21:00Z is already the next Tehran day
    expect(toWallClock(new Date("2026-07-20T21:00:00Z"), TEHRAN)).toEqual({
      date: "2026-07-21",
      minutes: 30,
    });
  });

  it("finds the latest daily slot, wrapping to yesterday before the anchor", () => {
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 240 }, "03:30", 24)).toEqual({
      date: "2026-07-21",
      minutes: 210,
    });
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 180 }, "03:30", 24)).toEqual({
      date: "2026-07-20",
      minutes: 210,
    });
  });

  it("steps sub-daily slots off the anchor", () => {
    // anchor 00:30, every 6h → 00:30 / 06:30 / 12:30 / 18:30
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 13 * 60 }, "00:30", 6)).toEqual({
      date: "2026-07-21",
      minutes: 12 * 60 + 30,
    });
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 10 }, "00:30", 6)).toEqual({
      date: "2026-07-20",
      minutes: 18 * 60 + 30,
    });
  });
});

describe("isBackupDue", () => {
  const config = { enabled: true, anchorTime: "03:30", intervalHours: 24 };

  it("is never due while disabled", () => {
    expect(isBackupDue(null, new Date(), { ...config, enabled: false }, TEHRAN)).toBe(false);
  });

  it("is due immediately when nothing ever ran", () => {
    expect(isBackupDue(null, new Date("2026-07-21T08:00:00Z"), config, TEHRAN)).toBe(true);
  });

  it("is due once a slot passes without a run, and not again after covering it", () => {
    // 00:05Z = 03:35 Tehran, just past today's 03:30 slot
    const now = new Date("2026-07-21T00:05:00Z");
    const beforeSlot = "2026-07-20T23:00:00Z"; // 02:30 Tehran, before the slot
    const afterSlot = "2026-07-21T00:01:00Z"; // 03:31 Tehran, covers the slot
    expect(isBackupDue(beforeSlot, now, config, TEHRAN)).toBe(true);
    expect(isBackupDue(afterSlot, now, config, TEHRAN)).toBe(false);
  });

  it("yesterday's run stays sufficient until today's anchor passes", () => {
    const ranYesterday = "2026-07-20T00:10:00Z"; // 03:40 Tehran on the 20th
    const beforeAnchor = new Date("2026-07-20T22:00:00Z"); // 01:30 Tehran on the 21st
    const afterAnchor = new Date("2026-07-21T00:10:00Z"); // 03:40 Tehran on the 21st
    expect(isBackupDue(ranYesterday, beforeAnchor, config, TEHRAN)).toBe(false);
    expect(isBackupDue(ranYesterday, afterAnchor, config, TEHRAN)).toBe(true);
  });
});

describe("isFailedRunRetryDue", () => {
  const config = { enabled: true, anchorTime: "03:30", intervalHours: 24 };

  it("retries a covered-but-failed slot only after the backoff", () => {
    const failedAt = "2026-07-21T00:01:00Z"; // 03:31 Tehran — started in the slot, then failed
    const now = new Date("2026-07-21T00:05:00Z"); // 03:35 Tehran, same slot
    // The slot is "covered" by started_at, so a plain isBackupDue says no…
    expect(isBackupDue(failedAt, now, config, TEHRAN)).toBe(false);
    // …and the retry is still inside its backoff window.
    expect(isFailedRunRetryDue(failedAt, "failed", now, config, TEHRAN)).toBe(false);
    // Once LOCAL_RETRY_MS elapses, the failed run becomes due again.
    const afterBackoff = new Date(new Date(failedAt).getTime() + LOCAL_RETRY_MS);
    expect(isFailedRunRetryDue(failedAt, "failed", afterBackoff, config, TEHRAN)).toBe(true);
  });

  it("never retries a success, an in-flight run, or a run from a previous slot", () => {
    const now = new Date("2026-07-21T00:05:00Z");
    expect(isFailedRunRetryDue("2026-07-21T00:01:00Z", "success", now, config, TEHRAN)).toBe(false);
    expect(isFailedRunRetryDue("2026-07-21T00:01:00Z", "running", now, config, TEHRAN)).toBe(false);
    // A run from before the slot is a fresh-slot case for isBackupDue, not a retry.
    expect(isFailedRunRetryDue("2026-07-20T23:00:00Z", "failed", now, config, TEHRAN)).toBe(false);
    expect(
      isFailedRunRetryDue("2026-07-21T00:01:00Z", "failed", now, { ...config, enabled: false }, TEHRAN),
    ).toBe(false);
  });
});

describe("selectPrunable", () => {
  const names = [
    "pos-backup-20260718-033001.dump",
    "pos-backup-20260721-033001.dump",
    "pos-backup-20260719-033001.dump",
    "pos-backup-20260720-033001.dump",
    "notes.txt", // never touched
  ];

  it("keeps the newest N artifacts and never touches foreign files", () => {
    expect(selectPrunable(names, 2).sort()).toEqual([
      "pos-backup-20260718-033001.dump",
      "pos-backup-20260719-033001.dump",
    ]);
    expect(selectPrunable(names, 10)).toEqual([]);
  });

  it("works on prefixed encrypted object keys", () => {
    const keys = [
      "pos-backups/pos-backup-20260720-033001.dump.enc",
      "pos-backups/pos-backup-20260721-033001.dump.enc",
    ];
    expect(selectPrunable(keys, 1)).toEqual(["pos-backups/pos-backup-20260720-033001.dump.enc"]);
  });
});

describe("staleness and alerting", () => {
  const now = new Date("2026-07-21T12:00:00Z");

  it("nightly backups get a 30h window (24h + 6h grace)", () => {
    expect(backupStaleAfterMs(24)).toBe(30 * 60 * 60 * 1000);
    expect(backupStaleAfterMs(1)).toBe(2 * 60 * 60 * 1000); // grace floor: 1h
  });

  it("flags missing or old successes as stale", () => {
    expect(isBackupStale(null, 24, now)).toBe(true);
    expect(isBackupStale("2026-07-20T10:00:00Z", 24, now)).toBe(false); // 26h ago < 30h
    expect(isBackupStale("2026-07-19T10:00:00Z", 24, now)).toBe(true); // 50h ago
  });

  const base: BackupAlertInput = {
    enabled: true,
    cloudEnabled: true,
    intervalHours: 24,
    localLastSuccessAt: "2026-07-21T03:30:00Z",
    localLastError: null,
    cloudLastSuccessAt: "2026-07-21T03:31:00Z",
    cloudLastError: null,
  };

  it("walks the severity ladder", () => {
    expect(computeBackupAlert(base, now)).toEqual({ level: "ok", reason: "ok" });
    expect(computeBackupAlert({ ...base, enabled: false }, now)).toEqual({
      level: "warning",
      reason: "disabled",
    });
    expect(computeBackupAlert({ ...base, localLastError: "pg_dump exited 1" }, now)).toEqual({
      level: "error",
      reason: "local_failed",
    });
    expect(computeBackupAlert({ ...base, localLastSuccessAt: null }, now)).toEqual({
      level: "error",
      reason: "local_stale",
    });
    expect(computeBackupAlert({ ...base, cloudLastError: "unreachable" }, now)).toEqual({
      level: "error",
      reason: "cloud_failed",
    });
    expect(computeBackupAlert({ ...base, cloudLastSuccessAt: null }, now)).toEqual({
      level: "error",
      reason: "cloud_stale",
    });
    // cloud problems don't alert while cloud backup is off
    expect(
      computeBackupAlert({ ...base, cloudEnabled: false, cloudLastSuccessAt: null }, now),
    ).toEqual({ level: "ok", reason: "ok" });
  });
});

describe("cloud artifact encryption", () => {
  const plain = Buffer.from("PGDMP fake dump bytes — پشتیبان آزمایشی", "utf8");

  it("round-trips and marks the format", () => {
    const enc = encryptBackup(plain, "correct horse battery");
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(isEncryptedBackup(plain)).toBe(false);
    expect(decryptBackup(enc, "correct horse battery").equals(plain)).toBe(true);
  });

  it("produces different ciphertext each time (fresh salt/IV)", () => {
    const a = encryptBackup(plain, "pass-phrase-1");
    const b = encryptBackup(plain, "pass-phrase-1");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a wrong passphrase and any tampering", () => {
    const enc = encryptBackup(plain, "correct horse battery");
    expect(() => decryptBackup(enc, "wrong passphrase")).toThrow(/wrong passphrase|corrupted/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 20] ^= 0xff;
    expect(() => decryptBackup(tampered, "correct horse battery")).toThrow();
    expect(() => decryptBackup(plain, "x")).toThrow(/bad magic/);
    expect(() => decryptBackup(enc.subarray(0, 20), "x")).toThrow(/truncated/);
  });
});

describe("dumpDatabaseUrl", () => {
  const admin = "postgres://pos:pw@db:5432/pos";
  const app = "postgres://pos_app:pw@db:5432/pos";

  it("prefers the privileged BACKUP_DATABASE_URL over the app's connection", () => {
    // The app runs as pos_app (NOBYPASSRLS); dumping as it fails on the first COPY.
    expect(dumpDatabaseUrl({ BACKUP_DATABASE_URL: admin, DATABASE_URL: app })).toBe(admin);
  });

  it("falls back to DATABASE_URL, ignoring blank overrides", () => {
    expect(dumpDatabaseUrl({ DATABASE_URL: admin })).toBe(admin);
    expect(dumpDatabaseUrl({ BACKUP_DATABASE_URL: "  ", DATABASE_URL: admin })).toBe(admin);
  });

  it("throws when neither is set", () => {
    expect(() => dumpDatabaseUrl({})).toThrow(/BACKUP_DATABASE_URL|DATABASE_URL/);
  });
});

describe("isPlainArtifactName", () => {
  it("accepts the names the backup runner actually produces", () => {
    expect(isPlainArtifactName(makeArtifactName(new Date("2026-07-21T03:30:05Z")))).toBe(true);
    expect(isPlainArtifactName("pos-backup-20260721-033005.dump.enc")).toBe(true);
  });

  it("rejects anything that could escape the backup directory", () => {
    // The restore route takes this straight from the request body, so a
    // traversal here would read (and try to restore) an arbitrary file.
    for (const attempt of [
      "../../.env",
      "..\\..\\.env",
      "/etc/passwd",
      "D:\\secrets\\dump",
      "sub/pos-backup-20260721-033005.dump",
      "..",
      ".",
      "",
    ]) {
      expect(isPlainArtifactName(attempt)).toBe(false);
    }
  });
});
