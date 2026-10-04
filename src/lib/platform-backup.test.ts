/**
 * The pure decisions behind the console's full-system backup and its
 * address-based restore.
 *
 * These are the branches a reviewer most needs pinned, because they are the
 * ones standing between "restore from another server" and a footgun: which
 * config is accepted, what an artifact name is allowed to look like, what a
 * peer's manifest is allowed to say, when a whole-database replacement is
 * refused outright, and when it needs the confirmation phrase.
 *
 * Same shape as `backup.test.ts`: no database, no filesystem, no network —
 * fixtures in, verdicts out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSyncToken } from "./sync-token";
import {
  checkPeerManifest,
  DEFAULT_PLATFORM_BACKUP_CONFIG,
  hashPeerToken,
  isEncryptedArtifactName,
  isPeerId,
  isServeableArtifactName,
  maskPlatformBackupConfig,
  newestArtifact,
  normalizePeerBaseUrl,
  normalizePeerToken,
  parsePeerManifest,
  peerDownloadUrl,
  peerManifestUrl,
  peerTokenHint,
  pickPeerArtifact,
  platformBackupAlert,
  platformBackupPassphrase,
  platformCloudKeyFor,
  resolveMaxDownloadBytes,
  resolveRestorePlan,
  sha256Of,
  checksumAcceptable,
  timezoneIsResolvable,
  validatePlatformBackupConfig,
  PLATFORM_RESTORE_CONFIRM_PHRASE,
  type PeerManifest,
  type PlatformBackupConfig,
} from "./platform-backup";

const NEWEST = "pos-backup-20260801-033000.dump.enc";
const OLDER = "pos-backup-20260731-033000.dump.enc";

function config(overrides: Partial<PlatformBackupConfig> = {}): PlatformBackupConfig {
  return {
    ...structuredClone(DEFAULT_PLATFORM_BACKUP_CONFIG),
    ...overrides,
    cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, ...(overrides.cloud ?? {}) },
  };
}

/** A cloud block that would actually upload, for tests about something other than the target. */
function completeCloud(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud,
    enabled: true,
    endpoint: "https://s3.ir-thr-at1.arvanstorage.ir",
    region: "ir-thr-at1",
    bucket: "cafe-backups",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI-KEXAMPLE",
    ...overrides,
  };
}

/** A body the console PUTs: everything valid, nothing set beyond the minimum. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    timezone: "Asia/Tehran",
    localRetention: 14,
    ...overrides,
  };
}

describe("validatePlatformBackupConfig", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.BACKUP_PASSPHRASE;
    delete process.env.PLATFORM_BACKUP_PASSPHRASE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts a minimal local-only config and defaults the untouched fields", () => {
    const v = validatePlatformBackupConfig(body());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.config.enabled).toBe(true);
    expect(v.config.timezone).toBe("Asia/Tehran");
    expect(v.config.cloud.enabled).toBe(false);
    expect(v.config.servingEnabled).toBe(false);
    expect(v.config.allowInsecurePeers).toBe(false);
    expect(v.config.encryptLocal).toBe(true);
    // Empty directories are a real value, not a missing one: "" means "the
    // default place", which is what an install predating this page uses.
    expect(v.config.directory).toBe("");
  });

  it("refuses a body that is not an object", () => {
    expect(validatePlatformBackupConfig(null)).toEqual({ ok: false, error: "not_an_object" });
    expect(validatePlatformBackupConfig("nope")).toEqual({ ok: false, error: "not_an_object" });
    expect(validatePlatformBackupConfig([])).toEqual({ ok: false, error: "not_an_object" });
  });

  it("only allows the documented intervals", () => {
    expect(validatePlatformBackupConfig(body({ intervalHours: 5 })).ok).toBe(false);
    expect(validatePlatformBackupConfig(body({ intervalHours: 5 }))).toEqual({
      ok: false,
      error: "invalid_interval",
    });
    expect(validatePlatformBackupConfig(body({ intervalHours: 6 })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ intervalHours: "12" })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ intervalHours: NaN })).ok).toBe(false);
  });

  it("validates the anchor time as a wall clock, not a free string", () => {
    expect(validatePlatformBackupConfig(body({ anchorTime: "25:00" }))).toEqual({
      ok: false,
      error: "invalid_anchor_time",
    });
    expect(validatePlatformBackupConfig(body({ anchorTime: "3:30" })).ok).toBe(false);
    expect(validatePlatformBackupConfig(body({ anchorTime: "23:59" })).ok).toBe(true);
  });

  it("rejects a timezone Intl cannot resolve", () => {
    expect(validatePlatformBackupConfig(body({ timezone: "Mars/Olympus_Mons" }))).toEqual({
      ok: false,
      error: "invalid_timezone",
    });
    expect(validatePlatformBackupConfig(body({ timezone: "UTC" })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ timezone: "Europe/Berlin" })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ timezone: "" })).ok).toBe(true); // → the default
    expect(timezoneIsResolvable("Asia/Tehran")).toBe(true);
    expect(timezoneIsResolvable("Not/AZone")).toBe(false);
    expect(timezoneIsResolvable("1234")).toBe(false);
  });

  it("bounds both retention counts", () => {
    expect(validatePlatformBackupConfig(body({ localRetention: 0 }))).toEqual({
      ok: false,
      error: "invalid_local_retention",
    });
    expect(validatePlatformBackupConfig(body({ localRetention: 366 }))).toEqual({
      ok: false,
      error: "invalid_local_retention",
    });
    expect(
      validatePlatformBackupConfig(body({ cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, retention: 0 } })),
    ).toEqual({ ok: false, error: "invalid_cloud_retention" });
  });

  it("keeps directory paths out of the regex business but rejects NUL", () => {
    expect(validatePlatformBackupConfig(body({ directory: "D:\\backups" })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ directory: "/mnt/nas/pos" })).ok).toBe(true);
    expect(validatePlatformBackupConfig(body({ directory: 42 }))).toEqual({
      ok: false,
      error: "invalid_directory",
    });
    expect(validatePlatformBackupConfig(body({ directory: "/a\0b" })).ok).toBe(false);
  });

  it("refuses to mirror onto the directory it is mirroring", () => {
    expect(
      validatePlatformBackupConfig(body({ directory: "/mnt/nas", secondaryDirectory: "/mnt/nas" })),
    ).toEqual({ ok: false, error: "secondary_same_as_primary" });
    expect(
      validatePlatformBackupConfig(body({ directory: "/mnt/nas", secondaryDirectory: "/mnt/usb" })).ok,
    ).toBe(true);
  });

  it("requires a real passphrase before cloud mirroring can be enabled", () => {
    const cloud = completeCloud();
    expect(validatePlatformBackupConfig(body({ cloud }))).toEqual({ ok: false, error: "passphrase_required" });
    expect(
      validatePlatformBackupConfig(body({ cloud, passphrase: "correct horse battery staple" })).ok,
    ).toBe(true);
    expect(validatePlatformBackupConfig(body({ cloud, passphrase: "short" }))).toEqual({
      ok: false,
      error: "weak_passphrase",
    });
  });

  it("accepts an environment passphrase in place of a typed one", () => {
    process.env.PLATFORM_BACKUP_PASSPHRASE = "from-the-environment";
    const cloud = completeCloud();
    expect(validatePlatformBackupConfig(body({ cloud })).ok).toBe(true);
    // …but a *typed* one that is too short is still refused, whatever env holds.
    expect(validatePlatformBackupConfig(body({ cloud, passphrase: "abc" }))).toEqual({
      ok: false,
      error: "weak_passphrase",
    });
  });

  it("does not force a passphrase for plaintext local backups, matching the tenant side", () => {
    // encryptLocal defaults on, and installs that never set a passphrase write
    // plaintext locally; refusing to save those configs would make the page
    // unusable on every install that predates it. The mask warns instead.
    expect(validatePlatformBackupConfig(body({ encryptLocal: true })).ok).toBe(true);
  });

  it("validates the cloud target the way an S3 client needs it", () => {
    const withPass = { passphrase: "long-enough-phrase" };
    expect(
      validatePlatformBackupConfig(body({ ...withPass, cloud: completeCloud({ endpoint: "s3.ir-thr-at1.arvanstorage.ir" }) })),
    ).toEqual({ ok: false, error: "invalid_cloud_endpoint" });
    expect(
      validatePlatformBackupConfig(body({ ...withPass, cloud: completeCloud({ bucket: "" }) })),
    ).toEqual({ ok: false, error: "missing_cloud_bucket" });
    expect(
      validatePlatformBackupConfig(body({ ...withPass, cloud: completeCloud({ secretAccessKey: "" }) })),
    ).toEqual({ ok: false, error: "missing_cloud_credentials" });
    // Disabled cloud storage keeps its half-configured values without complaint:
    // the form saves both halves at once, and a bucket the operator has not
    // filled in yet is not a reason to refuse a schedule change.
    expect(validatePlatformBackupConfig(body({ cloud: completeCloud({ enabled: false, bucket: "" }) })).ok).toBe(true);
  });

  it("normalizes the object key prefix and refuses an absolute one", () => {
    const v = validatePlatformBackupConfig(
      body({ cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, prefix: "nightly" } }),
    );
    expect(v.ok && v.config.cloud.prefix).toBe("nightly/");
    expect(
      validatePlatformBackupConfig(body({ cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, prefix: "/abs" } })),
    ).toEqual({ ok: false, error: "invalid_cloud_prefix" });
  });

  it("keeps stored secrets when the body omits them, and clears them when it sends empty", () => {
    const existing = config({ passphrase: "stored-passphrase", cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, secretAccessKey: "stored-secret" } });
    const kept = validatePlatformBackupConfig(body({ localRetention: 7 }), existing);
    expect(kept.ok && kept.config.passphrase).toBe("stored-passphrase");
    expect(kept.ok && kept.config.cloud.secretAccessKey).toBe("stored-secret");

    const cleared = validatePlatformBackupConfig(
      body({ cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, secretAccessKey: "" } }),
      existing,
    );
    expect(cleared.ok && cleared.config.cloud.secretAccessKey).toBe("");
  });
});

describe("platformBackupPassphrase", () => {
  it("prefers the stored config, then the platform env var, then the legacy one", () => {
    expect(platformBackupPassphrase({ passphrase: "stored" }, { PLATFORM_BACKUP_PASSPHRASE: "env" })).toBe("stored");
    expect(platformBackupPassphrase({ passphrase: "" }, { PLATFORM_BACKUP_PASSPHRASE: "env", BACKUP_PASSPHRASE: "legacy" })).toBe("env");
    expect(platformBackupPassphrase({ passphrase: "" }, { BACKUP_PASSPHRASE: "legacy" })).toBe("legacy");
    expect(platformBackupPassphrase(null, {})).toBe("");
    expect(platformBackupPassphrase(undefined, {})).toBe("");
  });

  it("strips a trailing newline, which is how `echo secret > file` arrives", () => {
    expect(platformBackupPassphrase({ passphrase: "" }, { PLATFORM_BACKUP_PASSPHRASE: "secret\n" })).toBe("secret");
    expect(platformBackupPassphrase({ passphrase: "" }, { PLATFORM_BACKUP_PASSPHRASE: "secret\r\n" })).toBe("secret");
    // …and only the trailing one: a passphrase that legitimately ends in a
    // space keeps it, because scrypt hashes the bytes it is given.
    expect(platformBackupPassphrase({ passphrase: "secret " }, {})).toBe("secret ");
  });
});

describe("maskPlatformBackupConfig", () => {
  it("never returns a secret, only whether one is set", () => {
    const masked = maskPlatformBackupConfig(
      config({
        passphrase: "a-passphrase-that-must-not-leave-the-server",
        cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, secretAccessKey: "super-secret-key", enabled: true, endpoint: "https://s3", bucket: "b", accessKeyId: "id" },
      }),
      {},
    );
    expect(masked.passphrase).toBe("");
    expect(masked.hasPassphrase).toBe(true);
    expect(masked.cloud.secretAccessKey).toBe("");
    expect(masked.cloud.hasSecretAccessKey).toBe(true);
    expect(JSON.stringify(masked)).not.toContain("super-secret-key");
    expect(JSON.stringify(masked)).not.toContain("a-passphrase-that-must-not-leave-the-server");
    expect(masked.cloud.accessKeyId).toBe("id"); // an id is not a secret; it is what the form must echo back
  });

  it("warns about the states an operator would otherwise only discover at restore time", () => {
    const bare = maskPlatformBackupConfig(config({ passphrase: "" }), {});
    expect(bare.warnings.join(" ")).toMatch(/plaintext/i);

    const serving = maskPlatformBackupConfig(config({ passphrase: "long-enough", servingEnabled: true }), {});
    expect(serving.warnings.join(" ")).toMatch(/peer token/i);

    const cloudNoEndpoint = maskPlatformBackupConfig(
      config({ passphrase: "long-enough", cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, enabled: true, endpoint: "" } }),
      {},
    );
    expect(cloudNoEndpoint.warnings.join(" ")).toMatch(/endpoint/i);
  });

  it("treats an env-only passphrase as set, because it is", () => {
    const masked = maskPlatformBackupConfig(config({ passphrase: "" }), { PLATFORM_BACKUP_PASSPHRASE: "from-env" });
    expect(masked.hasPassphrase).toBe(true);
    expect(masked.warnings).toEqual([]);
  });
});

describe("artifact grammar", () => {
  it("accepts exactly this product's artifact names", () => {
    expect(isServeableArtifactName(NEWEST)).toBe(true);
    expect(isServeableArtifactName("pos-backup-20260801-033000.dump")).toBe(true);
    expect(isEncryptedArtifactName(NEWEST)).toBe(true);
    expect(isEncryptedArtifactName("pos-backup-20260801-033000.dump")).toBe(false);
  });

  it("refuses anything that could escape the backup directory", () => {
    for (const name of [
      "",
      ".",
      "..",
      "../pos-backup-20260801-033000.dump",
      "sub/dir/pos-backup-20260801-033000.dump",
      "..\\pos-backup-20260801-033000.dump",
      "/etc/passwd",
      "pos-backup-20260801-033000.dump.enc\u0000.txt",
      "notes.txt",
      "pos-backup-2026.dump",
      // A NUL or a newline in a name is not a filename, it is an attempt.
      "pos-backup-20260801-033000.dump\n.enc",
    ]) {
      expect(isServeableArtifactName(name), name).toBe(false);
    }
  });

  it("builds cloud keys under the configured prefix, always encrypted", () => {
    expect(platformCloudKeyFor("pos-backups/", "pos-backup-20260801-033000.dump")).toBe(
      "pos-backups/pos-backup-20260801-033000.dump.enc",
    );
    expect(platformCloudKeyFor("pos-backups/", NEWEST)).toBe(`pos-backups/${NEWEST}`);
    expect(platformCloudKeyFor("", NEWEST)).toBe(NEWEST);
  });
});

describe("artifact selection", () => {
  it("takes the newest by the embedded UTC stamp", () => {
    const rows = [{ artifact: OLDER }, { artifact: NEWEST }, { artifact: "pos-backup-20260801-032959.dump" }];
    expect(newestArtifact(rows)?.artifact).toBe(NEWEST);
    expect(newestArtifact([])).toBe(null);
  });

  it("honours an explicit request, and refuses a name it does not offer", () => {
    const rows = [
      { artifact: NEWEST, sizeBytes: 10 },
      { artifact: OLDER, sizeBytes: 20 },
    ];
    expect(pickPeerArtifact(rows, "")).toEqual({ ok: true, artifact: rows[0] });
    expect(pickPeerArtifact(rows, OLDER)).toEqual({ ok: true, artifact: rows[1] });
    expect(pickPeerArtifact(rows, "pos-backup-20200101-000000.dump")).toEqual({
      ok: false,
      error: "unknown_artifact",
    });
    expect(pickPeerArtifact(rows, "../../etc/passwd")).toEqual({ ok: false, error: "unsafe_artifact_name" });
    expect(pickPeerArtifact([], null)).toEqual({ ok: false, error: "no_artifacts" });
  });
});

/** The url of an accepted address, or the failure — so tests read as intent. */
function urlOf(result: ReturnType<typeof normalizePeerBaseUrl>): string | undefined {
  return result.ok ? result.url : undefined;
}

describe("normalizePeerBaseUrl", () => {
  it("accepts and canonicalizes a real address", () => {
    expect(normalizePeerBaseUrl("https://pos.example.com/")).toEqual({
      ok: true,
      url: "https://pos.example.com",
      secure: true,
    });
    expect(urlOf(normalizePeerBaseUrl("https://pos.example.com"))).toBe("https://pos.example.com");
    // A base path is legitimate (an app behind a subpath proxy) and is kept.
    expect(urlOf(normalizePeerBaseUrl("https://example.com/pos/"))).toBe("https://example.com/pos");
    expect(urlOf(normalizePeerBaseUrl("https://192.168.1.20:3000"))).toBe("https://192.168.1.20:3000");
  });

  it("requires https unless the operator opted into a LAN peer", () => {
    expect(normalizePeerBaseUrl("http://192.168.1.20:3000")).toEqual({ ok: false, error: "https_required" });
    expect(normalizePeerBaseUrl("http://192.168.1.20:3000", { allowInsecure: true })).toEqual({
      ok: true,
      url: "http://192.168.1.20:3000",
      secure: false,
    });
  });

  it("refuses anything that is not a plain origin", () => {
    for (const raw of [
      "",
      "   ",
      "pos.example.com", // no scheme at all is the most common paste error
      "ftp://pos.example.com",
      "file:///etc/passwd",
      "https://user:pass@pos.example.com", // credentials in a URL are never intended
      "https://pos.example.com?debug=1",
      "https://pos.example.com#frag",
      "https://",
      "https://exa mple.com",
      "https://exa\u200bmple.com", // a zero-width space from an RTL paste
      null,
      42,
      "x".repeat(600),
    ]) {
      const r = normalizePeerBaseUrl(raw);
      expect(r.ok, String(raw)).toBe(false);
    }
  });

  it("resolves a dot-segment address instead of storing it verbatim", () => {
    // `new URL()` collapses `..` before anything here sees it, so what is
    // stored — and later requested — is the resolved path, never a traversal.
    expect(urlOf(normalizePeerBaseUrl("https://pos.example.com/a/../b"))).toBe("https://pos.example.com/b");
    expect(normalizePeerBaseUrl("https://pos.example.com//double").ok).toBe(false);
    // An encoded dot-dot is not a secret path either: the URL layer decodes and
    // collapses it, so the peer is asked for the plain path it resolves to.
    expect(urlOf(normalizePeerBaseUrl("https://pos.example.com/%2e%2e/etc"))).toBe("https://pos.example.com/etc");
  });

  it("lets a presigned download URL keep its query, because that is the signature", () => {
    expect(normalizePeerBaseUrl("https://s3.example.com/b/k?X-Amz-Signature=abc")).toEqual({
      ok: false,
      error: "invalid_url",
    });
    const presigned = normalizePeerBaseUrl("https://s3.example.com/b/k?X-Amz-Signature=abc", {
      allowQuery: true,
    });
    expect(presigned.ok).toBe(true);
    if (presigned.ok) expect(presigned.url).toBe("https://s3.example.com/b/k?X-Amz-Signature=abc");
    // …but a fragment is still refused: it never reaches the server, so keeping
    // it would silently truncate what the operator meant.
    expect(normalizePeerBaseUrl("https://x.example.com/a#b", { allowQuery: true }).ok).toBe(false);
  });
});

describe("peer endpoints", () => {
  it("appends the contract's paths to the base without doubling slashes", () => {
    expect(peerManifestUrl("https://pos.example.com")).toBe("https://pos.example.com/api/peer/backup/manifest");
    expect(peerManifestUrl("https://pos.example.com/")).toBe("https://pos.example.com/api/peer/backup/manifest");
    expect(peerManifestUrl("https://example.com/pos")).toBe("https://example.com/pos/api/peer/backup/manifest");
    expect(peerDownloadUrl("https://pos.example.com", NEWEST)).toBe(
      `https://pos.example.com/api/peer/backup/download?artifact=${encodeURIComponent(NEWEST)}`,
    );
  });
});

describe("peer tokens", () => {
  it("canonicalizes whatever was pasted, and catches a mistyped character", () => {
    const good = normalizePeerToken(generateValidToken());
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const withSpaces = normalizePeerToken(`  ${good.token.replaceAll("-", " ")}  `);
    expect(withSpaces.ok && withSpaces.token).toBe(good.token);
    const lower = normalizePeerToken(good.token.toLowerCase());
    expect(lower.ok && lower.token).toBe(good.token);

    const typo = normalizePeerToken(`${good.token.slice(0, -4)}ZZZZ-${good.token.slice(-2)}`);
    expect(typo.ok).toBe(false);
  });

  it("accepts a legacy hex secret verbatim, and rejects junk", () => {
    const legacy = "0".repeat(64);
    const r = normalizePeerToken(legacy);
    expect(r.ok && r.token).toBe(legacy);
    expect(normalizePeerToken("")).toEqual({ ok: false, error: "missing_token" });
    expect(normalizePeerToken("hello")).toEqual({ ok: false, error: "bad_prefix" });
    expect(normalizePeerToken("ABC1-0000-0000-0000-0000-0000-0000-0000-00")).toEqual({
      ok: false,
      error: "bad_prefix",
    });
    expect(normalizePeerToken("POS1-00")).toEqual({ ok: false, error: "bad_length" });
  });

  it("hashes the canonical form so both sides agree, and never matches a different token", () => {
    const token = generateValidToken();
    expect(hashPeerToken(token)).toBe(hashPeerToken(token));
    expect(hashPeerToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPeerToken(token)).not.toBe(hashPeerToken(generateValidToken()));
  });

  it("shows a hint that identifies a token without reproducing it", () => {
    const token = generateValidToken();
    const hint = peerTokenHint(token);
    expect(hint).not.toBe(token);
    expect(hint.length).toBeLessThan(token.length);
    expect(token.startsWith("POS1-")).toBe(true);
    expect(hint.startsWith("POS1")).toBe(true);
    expect(peerTokenHint("short")).toBe("hort");
  });
});

/** A checksum-valid POS1 token, produced by the same generator the app uses. */
function generateValidToken(): string {
  return generateSyncToken();
}

describe("parsePeerManifest", () => {
  const valid = {
    app: "cafe-restaurant-pos",
    version: "sha-abc1234",
    databaseName: "pos",
    pgServerMajor: 16,
    schemaMigrations: 132,
    latestMigration: "0132_platform_system_backup.sql",
    businessCount: 3,
    artifacts: [
      { artifact: NEWEST, sizeBytes: 1234, sha256: "a".repeat(64), createdAt: "2026-08-01T03:30:00.000Z", encrypted: true },
    ],
  };

  it("accepts a well-formed manifest and drops fields this app does not define", () => {
    const parsed = parsePeerManifest({ ...valid, extraHostileField: { do: "this" } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.artifacts[0].artifact).toBe(NEWEST);
    expect(parsed.manifest.schemaMigrations).toBe(132);
    expect(JSON.stringify(parsed.manifest)).not.toContain("extraHostileField");
  });

  it("refuses a manifest from anything that is not this app", () => {
    expect(parsePeerManifest({ ...valid, app: "some-other-pos" })).toEqual({ ok: false, error: "bad_manifest" });
    expect(parsePeerManifest({ ...valid, app: undefined })).toEqual({ ok: false, error: "bad_manifest" });
  });

  it("refuses a peer that names a file it should not be able to name", () => {
    for (const artifact of ["../../etc/shadow", "", "notes.txt", `nested/${NEWEST}`]) {
      expect(
        parsePeerManifest({ ...valid, artifacts: [{ ...valid.artifacts[0], artifact }] }),
      ).toEqual({ ok: false, error: "bad_manifest" });
    }
  });

  it("refuses a malformed checksum, timestamp, or shape", () => {
    expect(parsePeerManifest({ ...valid, artifacts: "not-an-array" })).toEqual({ ok: false, error: "bad_manifest" });
    expect(parsePeerManifest({ ...valid, artifacts: null })).toEqual({ ok: false, error: "bad_manifest" });
    expect(parsePeerManifest({ ...valid, artifacts: [{ artifact: NEWEST, sha256: "ff".repeat(10) }] })).toEqual({
      ok: false,
      error: "bad_manifest",
    });
    expect(parsePeerManifest({ ...valid, artifacts: [{ artifact: NEWEST, createdAt: "not-a-date" }] })).toEqual({
      ok: false,
      error: "bad_manifest",
    });
    expect(parsePeerManifest(null)).toEqual({ ok: false, error: "bad_manifest" });
    expect(parsePeerManifest("")).toEqual({ ok: false, error: "bad_manifest" });
    expect(parsePeerManifest([])).toEqual({ ok: false, error: "bad_manifest" });
  });

  it("clamps nonsense numbers instead of trusting them", () => {
    const parsed = parsePeerManifest({
      ...valid,
      pgServerMajor: "16",
      schemaMigrations: -5,
      businessCount: null,
      artifacts: [{ artifact: NEWEST, sizeBytes: -1, sha256: "A".repeat(64) }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Strings are not numbers: a peer that sends "16" gets 0, not a coercion
    // that turns a hostile value into a plausible one.
    expect(parsed.manifest.pgServerMajor).toBe(0);
    expect(parsed.manifest.schemaMigrations).toBe(0);
    expect(parsed.manifest.businessCount).toBe(0);
    expect(parsed.manifest.artifacts[0].sizeBytes).toBe(0);
    expect(parsed.manifest.artifacts[0].sha256).toBe("a".repeat(64)); // lower-cased, as the check compares
  });

  it("tolerates a peer that published no checksum (an old build), leaving the byte check to the download", () => {
    const parsed = parsePeerManifest({ ...valid, artifacts: [{ artifact: NEWEST }] });
    expect(parsed.ok && parsed.manifest.artifacts[0].sha256).toBe("");
    expect(parsed.ok && parsed.manifest.artifacts[0].encrypted).toBe(false);
  });
});

describe("checkPeerManifest", () => {
  const manifest = (overrides: Partial<PeerManifest> = {}): PeerManifest => ({
    app: "cafe-restaurant-pos",
    version: "sha-abc1234",
    databaseName: "pos",
    pgServerMajor: 16,
    schemaMigrations: 132,
    latestMigration: "0132_platform_system_backup.sql",
    businessCount: 2,
    artifacts: [
      { artifact: NEWEST, sizeBytes: 1000, sha256: "b".repeat(64), createdAt: "", encrypted: false },
      { artifact: OLDER, sizeBytes: 900, sha256: "c".repeat(64), createdAt: "", encrypted: false },
    ],
    ...overrides,
  });

  const local = { schemaMigrations: 132, pgServerMajor: 16, hasPassphrase: true, secureTransport: true };

  it("says yes when the source is restorable by this build", () => {
    const check = checkPeerManifest(manifest(), local);
    expect(check).toEqual({ ok: true, warnings: [] });
  });

  it("refuses an app identity mismatch and an empty offering", () => {
    expect(checkPeerManifest(manifest({ app: "other" as never }), local)).toEqual({
      ok: false,
      error: "not_this_app",
    });
    expect(checkPeerManifest(manifest({ artifacts: [] }), local)).toEqual({ ok: false, error: "no_artifacts" });
  });

  it("refuses a schema this install has no migrations for", () => {
    // The whole point: after a restore, THIS code runs on THAT schema. A dump
    // from a newer build would land tables the running build never creates, and
    // the failure would surface as random errors days later.
    expect(checkPeerManifest(manifest({ schemaMigrations: 133 }), local)).toEqual({
      ok: false,
      error: "newer_schema",
    });
    expect(checkPeerManifest(manifest({ schemaMigrations: 132 }), local).ok).toBe(true);
  });

  it("refuses a dump pg_restore here cannot read", () => {
    expect(checkPeerManifest(manifest({ pgServerMajor: 18 }), local)).toEqual({
      ok: false,
      error: "newer_postgres",
    });
    // An unknown (0) figure on either side is not a reason to refuse: old builds
    // publish no server version at all.
    expect(checkPeerManifest(manifest({ pgServerMajor: 0 }), { ...local, pgServerMajor: 0 }).ok).toBe(true);
  });

  it("warns — without blocking — about the things an operator should see", () => {
    const behind = checkPeerManifest(manifest({ schemaMigrations: 129 }), local);
    expect(behind.ok && behind.warnings.join(" ")).toMatch(/rolls the schema back/);

    const encryptedNoKey = checkPeerManifest(
      manifest({ artifacts: [{ artifact: NEWEST, sizeBytes: 1, sha256: "", createdAt: "", encrypted: true }] }),
      { ...local, hasPassphrase: false },
    );
    expect(encryptedNoKey.ok && encryptedNoKey.warnings.join(" ")).toMatch(/passphrase/i);

    const insecure = checkPeerManifest(manifest(), {
      ...local,
      secureTransport: false,
      allowInsecurePeers: true,
    });
    expect(insecure.ok && insecure.warnings.join(" ")).toMatch(/plain http/);

    const emptyBusinesses = checkPeerManifest(manifest({ businessCount: 0 }), local);
    expect(emptyBusinesses.ok && emptyBusinesses.warnings.join(" ")).toMatch(/no businesses/);
  });

  it("refuses an artifact the peer never offered, rather than substituting the newest", () => {
    expect(
      checkPeerManifest(manifest(), local, "pos-backup-19990101-000000.dump.enc"),
    ).toEqual({ ok: false, error: "unknown_artifact" });
  });
});

describe("download limits", () => {
  it("defaults generously and honours a bigger figure, but never a nonsense one", () => {
    expect(resolveMaxDownloadBytes({})).toBe(2 * 1024 * 1024 * 1024);
    expect(resolveMaxDownloadBytes({ PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES: "5368709120" })).toBe(5_368_709_120);
    expect(resolveMaxDownloadBytes({ PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES: "10" })).toBe(2 * 1024 * 1024 * 1024);
    expect(resolveMaxDownloadBytes({ PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES: "banana" })).toBe(2 * 1024 * 1024 * 1024);
    expect(resolveMaxDownloadBytes({ PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES: "" })).toBe(2 * 1024 * 1024 * 1024);
  });

  it("verifies the bytes it received against the checksum it was promised", () => {
    const data = Buffer.from("pos-backup-bytes");
    const hex = sha256Of(data);
    expect(checksumAcceptable(data, hex)).toBe(true);
    expect(checksumAcceptable(data, hex.toUpperCase())).toBe(true);
    expect(checksumAcceptable(Buffer.from("pos-backup-byte"), hex)).toBe(false);
    // No declaration is not a pass: an unverified whole-database restore is how
    // a truncated transfer becomes a corrupted production system.
    expect(checksumAcceptable(data, "")).toBe(false);
  });
});

describe("resolveRestorePlan", () => {
  const peers = new Set(["11111111-1111-4111-8111-111111111111"]);

  it("treats anything but apply:true as the non-destructive verification", () => {
    const plan = resolveRestorePlan({ source: "peer", peerId: [...peers][0], artifact: NEWEST }, { knownPeerIds: peers });
    expect(plan).toMatchObject({ ok: true, mode: "verify" });
    for (const apply of [false, undefined, "yes", 1, null]) {
      const p = resolveRestorePlan({ source: "peer", peerId: [...peers][0], artifact: NEWEST, apply }, {
        knownPeerIds: peers,
      });
      expect(p.ok && (p as { mode: string }).mode).toBe("verify");
    }
  });

  it("requires the exact confirmation phrase to apply", () => {
    const base = { source: "peer", peerId: [...peers][0], artifact: NEWEST, apply: true };
    expect(resolveRestorePlan(base, { knownPeerIds: peers })).toEqual({ ok: false, error: "confirmation_required" });
    expect(resolveRestorePlan({ ...base, confirm: "  " + PLATFORM_RESTORE_CONFIRM_PHRASE + "  " }, { knownPeerIds: peers })).toMatchObject({
      ok: true,
      mode: "apply",
    });
    expect(resolveRestorePlan({ ...base, confirm: "delete-me" }, { knownPeerIds: peers })).toEqual({
      ok: false,
      error: "confirmation_required",
    });
    expect(resolveRestorePlan({ ...base, confirm: "بازگردانی کامل سيستم" }, { knownPeerIds: peers })).toEqual({
      ok: false,
      error: "confirmation_required",
    });
  });

  it("refuses a name that is not an artifact, in every source", () => {
    for (const source of ["local", "cloud", "peer", "url"]) {
      const r = resolveRestorePlan(
        { source, peerId: [...peers][0], url: "https://x.example.com/a.dump", artifact: "../.env" },
        { knownPeerIds: peers },
      );
      expect(r.ok, source).toBe(false);
    }
    expect(resolveRestorePlan({ source: "local", artifact: "" })).toEqual({ ok: false, error: "missing_artifact" });
  });

  it("only ever reaches a stored peer, never an arbitrary address through peerId", () => {
    const peersSet = new Set<string>(peers);
    expect(
      resolveRestorePlan({ source: "peer", peerId: "22222222-2222-4222-8222-222222222222", artifact: NEWEST }, {
        knownPeerIds: peersSet,
      }),
    ).toEqual({ ok: false, error: "peer_not_found" });
    expect(resolveRestorePlan({ source: "peer", artifact: NEWEST }, { knownPeerIds: peersSet })).toEqual({
      ok: false,
      error: "missing_peer",
    });
    expect(resolveRestorePlan({ source: "peer", peerId: "not-a-uuid", artifact: NEWEST }, { knownPeerIds: peersSet })).toEqual({
      ok: false,
      error: "invalid_peer",
    });
    expect(isPeerId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isPeerId("111111111111111111111111111111111111")).toBe(false);
  });

  it("derives the artifact from the address for a bare URL, and refuses a mismatch", () => {
    const url = `https://nas.local/shares/pos/${NEWEST}?token=abc`;
    const derived = resolveRestorePlan({ source: "url", url }, {});
    expect(derived).toMatchObject({ ok: true, source: "url", artifact: NEWEST });

    const agree = resolveRestorePlan({ source: "url", url, artifact: NEWEST }, {});
    expect(agree.ok).toBe(true);

    expect(
      resolveRestorePlan({ source: "url", url, artifact: OLDER }, {}),
    ).toEqual({ ok: false, error: "artifact_url_mismatch" });

    // An address with no artifact-looking last segment is not a backup file.
    expect(resolveRestorePlan({ source: "url", url: "https://nas.local/shares" }, {})).toEqual({
      ok: false,
      error: "url_has_no_artifact_name",
    });
    expect(
      resolveRestorePlan({ source: "url", url: "https://nas.local/shares/../../etc/passwd" }, {}),
    ).toMatchObject({ ok: false });
  });

  it("respects the insecure-peer switch for a URL as well as a stored peer", () => {
    const url = `http://nas.local/${NEWEST}`;
    expect(resolveRestorePlan({ source: "url", url }, {})).toEqual({ ok: false, error: "https_required" });
    expect(resolveRestorePlan({ source: "url", url }, { allowInsecurePeers: true }).ok).toBe(true);
  });

  it("refuses an unknown source and a NUL in a passphrase", () => {
    expect(resolveRestorePlan({ source: "sftp", artifact: NEWEST })).toEqual({
      ok: false,
      error: "invalid_source",
    });
    expect(
      resolveRestorePlan({ source: "local", artifact: NEWEST, passphrase: "a\0b" }).ok,
    ).toBe(false);
    expect(resolveRestorePlan("nope")).toEqual({ ok: false, error: "not_an_object" });
    expect(resolveRestorePlan(null)).toEqual({ ok: false, error: "not_an_object" });
  });

  it("keeps the one-shot passphrase out of everything except the plan itself", () => {
    const plan = resolveRestorePlan(
      { source: "local", artifact: NEWEST, passphrase: "typed-for-this-attempt-only" },
      {},
    );
    expect(plan.ok && (plan as { passphrase: string }).passphrase).toBe("typed-for-this-attempt-only");
  });
});

describe("cloud artifact identity (issue #807)", () => {
  const prefix = "platform-backups";
  const cloudArtifact = "pos-backup-20260101-033000-abcdef01.dump.enc";

  it("derives the object key from the configured prefix when only a name is sent", () => {
    const plan = resolveRestorePlan(
      { source: "cloud", artifact: cloudArtifact },
      { cloudPrefix: prefix },
    );
    expect(plan).toMatchObject({
      ok: true,
      source: "cloud",
      artifact: cloudArtifact,
      objectKey: `${prefix}/${cloudArtifact}`,
    });
  });

  it("refuses a key outside the configured prefix instead of trusting the browser", () => {
    const plan = resolveRestorePlan(
      { source: "cloud", objectKey: `someone-elses-bucket/${cloudArtifact}`, artifact: cloudArtifact },
      { cloudPrefix: prefix },
    );
    expect(plan).toEqual({ ok: false, error: "object_key_outside_prefix" });
  });

  it("refuses an object key that disagrees with the artifact name", () => {
    const plan = resolveRestorePlan(
      {
        source: "cloud",
        objectKey: `${prefix}/pos-backup-20260101-033000-99999999.dump.enc`,
        artifact: cloudArtifact,
      },
      { cloudPrefix: prefix },
    );
    expect(plan).toEqual({ ok: false, error: "artifact_key_mismatch" });
  });

  it("refuses traversal, absolute keys, backslashes and nested sub-paths", () => {
    const attempts = [
      `${prefix}/../${cloudArtifact}`,
      `/${prefix}/${cloudArtifact}`,
      `${prefix}\\${cloudArtifact}`,
      `${prefix}/nested/${cloudArtifact}`,
      `${prefix}/`,
      `${prefix}/notes.txt`,
    ];
    for (const objectKey of attempts) {
      const plan = resolveRestorePlan({ source: "cloud", objectKey, artifact: cloudArtifact }, { cloudPrefix: prefix });
      expect(plan.ok, objectKey).toBe(false);
    }
  });

  it("refuses an artifact the server cannot vouch for when a listing was supplied", () => {
    const known = new Set([cloudArtifact]);
    const stranger = "pos-backup-20250101-033000-11111111.dump.enc";
    expect(
      resolveRestorePlan({ source: "cloud", artifact: stranger }, { cloudPrefix: prefix, knownCloudArtifacts: known }),
    ).toEqual({ ok: false, error: "unknown_artifact" });
    expect(
      resolveRestorePlan({ source: "cloud", artifact: cloudArtifact }, { cloudPrefix: prefix, knownCloudArtifacts: known }),
    ).toMatchObject({ ok: true });
  });

  it("requires an artifact name for a cloud restore, and validates the key length", () => {
    expect(resolveRestorePlan({ source: "cloud" }, { cloudPrefix: prefix })).toEqual({
      ok: false,
      error: "missing_artifact",
    });
    expect(
      resolveRestorePlan({ source: "cloud", objectKey: `${prefix}/${"a".repeat(1100)}` }, { cloudPrefix: prefix }),
    ).toEqual({ ok: false, error: "missing_artifact" });
  });

  it("treats an empty prefix as the bucket root, not as 'anything goes'", () => {
    // No prefix configured: the key is the artifact name itself, and a
    // *prefixed* key is then the one that is out of scope.
    const plan = resolveRestorePlan({ source: "cloud", artifact: cloudArtifact }, { cloudPrefix: "" });
    expect(plan).toMatchObject({ ok: true, objectKey: cloudArtifact });
    // A key with a directory in it is not "the root prefix" — it is a sub-path.
    expect(
      resolveRestorePlan({ source: "cloud", objectKey: `sub/${cloudArtifact}`, artifact: cloudArtifact }, { cloudPrefix: "" }),
    ).toEqual({ ok: false, error: "unsafe_artifact_name" });
    // …and a cloud restore with no artifact name at all never reaches the key.
    expect(resolveRestorePlan({ source: "cloud", objectKey: `sub/${cloudArtifact}` }, { cloudPrefix: "" })).toEqual({
      ok: false,
      error: "missing_artifact",
    });
  });

  it("resolves the same identity for local, peer and url sources as null", () => {
    for (const source of ["local", "peer", "url"] as const) {
      const body =
        source === "peer"
          ? { source, peerId: "11111111-1111-4111-8111-111111111111", artifact: NEWEST }
          : source === "url"
            ? { source, url: `https://nas.example.com/${NEWEST}` }
            : { source, artifact: NEWEST };
      const plan = resolveRestorePlan(body, {
        knownPeerIds: new Set(["11111111-1111-4111-8111-111111111111"]),
      });
      expect(plan.ok && (plan as { objectKey: string | null }).objectKey, source).toBeNull();
    }
  });
});

describe("platformBackupAlert", () => {
  const base = {
    localLastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
    localLastError: null,
    cloudLastSuccessAt: new Date().toISOString(),
    cloudLastError: null,
  };

  it("mirrors the tenant-side alert vocabulary so the console and the dashboard agree", () => {
    expect(platformBackupAlert(config({ enabled: false }), base)).toEqual({ level: "warning", reason: "disabled" });
    expect(
      platformBackupAlert(config({ enabled: true }), { ...base, localLastError: "pg_dump exited with 2" }),
    ).toEqual({ level: "error", reason: "local_failed" });
    expect(
      platformBackupAlert(config({ enabled: true, cloud: { ...DEFAULT_PLATFORM_BACKUP_CONFIG.cloud, enabled: true } }), {
        ...base,
        cloudLastError: "put failed",
      }),
    ).toEqual({ level: "error", reason: "cloud_failed" });
    expect(
      platformBackupAlert(config({ enabled: true }), { ...base, localLastSuccessAt: null }),
    ).toEqual({ level: "error", reason: "local_stale" });
    expect(platformBackupAlert(config({ enabled: true }), base)).toEqual({ level: "ok", reason: "ok" });
  });
});
