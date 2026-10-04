/**
 * Full-system backup for the super-admin console — the framework-free half.
 *
 * The tenant-side pipeline lives in `backup.ts`; this module holds everything
 * the *platform* side decides that needs no database, no filesystem and no
 * network, so all of it is unit-tested in `platform-backup.test.ts`:
 *
 *   • the console's backup config (validation, masking, passphrase resolution,
 *     schedule/alerting — the schedule maths is imported from backup.ts, so a
 *     nightly slot means the same thing on both halves);
 *   • the transferable-artifact rules: what makes a name safe to hand to a
 *     peer, what a peer's manifest is allowed to say, and what this server
 *     refuses to restore;
 *   • the address half: normalizing a peer origin, requiring https, minting and
 *     verifying the POS1 token that authorizes one server to read another's
 *     backups, and resolving a restore request (verify vs. apply, confirmation
 *     phrase, size cap) into an exact plan *before* anything is downloaded.
 *
 * ### The cross-server flow this describes
 *
 * ```text
 *  OLD SERVER (serving)                       NEW SERVER (pulling)
 *  platform_backup_config.serving_enabled     /platform/backup → «بازیابی از آدرس»
 *  platform_backup_tokens (hashed)            platform_backup_peers (base_url + token)
 *          ▲                                            │
 *          └── GET /api/peer/backup/manifest ◄──────────┤  Bearer POS1-…
 *          └── GET /api/peer/backup/download?artifact= ◄┘  stream → sha256 → decrypt
 *                                                             → verify into a scratch DB
 *                                                             → apply (confirmation phrase)
 * ```
 *
 * Nothing here is trusted across that boundary: the peer's manifest is parsed
 * defensively (`parsePeerManifest`) and checked against *this* install
 * (`checkPeerManifest`), an artifact name is rejected unless it matches the
 * local artifact grammar exactly, a downloaded body must hash to the checksum
 * the manifest declared, and an encrypted artifact needs a passphrase that only
 * ever comes from this server's own config (or the operator typing it).
 */
import { createHash } from "node:crypto";
import {
  ALLOWED_INTERVAL_HOURS,
  ARTIFACT_RE,
  isPlainArtifactName,
  MAX_RETENTION,
  computeBackupAlert,
  type BackupAlert,
} from "./backup";
import { isLegacySyncToken, parseSyncToken } from "./sync-token";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PlatformBackupCloudConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  /** object key prefix, normalized to end with "/" (empty = bucket root) */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** keep this many newest objects under the prefix */
  retention: number;
}

export interface PlatformBackupConfig {
  /** master switch for the scheduled whole-system dump */
  enabled: boolean;
  intervalHours: number;
  /** "HH:MM" wall time in `timezone`; slots are anchor + k·interval */
  anchorTime: string;
  /** IANA zone the anchor time is read in */
  timezone: string;
  /** "" = BACKUP_DIR / ./backups (the tenant default, kept for compatibility) */
  directory: string;
  /** "" = none; a NAS/USB mirror of every artifact, whose failure fails the run */
  secondaryDirectory: string;
  localRetention: number;
  encryptLocal: boolean;
  /** AES-256-GCM passphrase — never echoed by any read path */
  passphrase: string;
  cloud: PlatformBackupCloudConfig;
  /** whether /api/peer/backup/* answers at all */
  servingEnabled: boolean;
  /** allow a peer address to be plain http (a machine on the operator's LAN) */
  allowInsecurePeers: boolean;
  /**
   * Issue #807 — allow a peer/direct-URL target on the private network
   * (RFC1918, CGNAT, IPv6 ULA, or loopback). LAN restore is a real feature, but
   * it is a deliberate decision, not a default: the outbound policy refuses
   * private targets unless this is set, and always refuses link-local,
   * multicast and cloud-metadata addresses whatever it says.
   */
  allowPrivatePeers: boolean;
}

export const DEFAULT_PLATFORM_BACKUP_CONFIG: PlatformBackupConfig = {
  enabled: false,
  intervalHours: 24,
  anchorTime: "03:30",
  timezone: "Asia/Tehran",
  directory: "",
  secondaryDirectory: "",
  localRetention: 14,
  encryptLocal: true,
  passphrase: "",
  cloud: {
    enabled: false,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "platform-backups/",
    accessKeyId: "",
    secretAccessKey: "",
    retention: 30,
  },
  servingEnabled: false,
  allowInsecurePeers: false,
  allowPrivatePeers: false,
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_PASSPHRASE_LENGTH = 8;
/**
 * An IANA name is `Area/Location` or a few special forms (UTC, Etc/GMT+3,
 * GMT-7…). A loose shape check here plus `Intl.DateTimeFormat`'s own validation
 * (see `timezoneIsResolvable`) is exactly what the tenant-side config does, and
 * a bad zone fails loudly at save time rather than silently shifting every
 * schedule slot by hours.
 */
export const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+~/-]*$/;

export function timezoneIsResolvable(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export type PlatformBackupConfigValidation =
  | { ok: true; config: PlatformBackupConfig }
  | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Normalize + validate the console's PUT /api/platform/backup/config body.
 *
 * Secrets follow the tenant-side convention: an *absent* field keeps what is
 * stored, an empty string clears it. `validate…` therefore cannot know whether
 * a cloud enable is short a secret, so the route merges the stored config in
 * before calling this (`mergeSecrets`) and the "keep" cases are already applied.
 */
export function validatePlatformBackupConfig(
  body: unknown,
  existing: PlatformBackupConfig = DEFAULT_PLATFORM_BACKUP_CONFIG,
): PlatformBackupConfigValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "not_an_object" };
  }
  const b = body as Record<string, unknown>;

  const enabled = Boolean(b.enabled ?? existing.enabled);
  const intervalHours = b.intervalHours === undefined ? existing.intervalHours : Number(b.intervalHours);
  if (!(ALLOWED_INTERVAL_HOURS as readonly number[]).includes(intervalHours)) {
    return { ok: false, error: "invalid_interval" };
  }
  const anchorTime = b.anchorTime === undefined ? existing.anchorTime : str(b.anchorTime);
  if (!TIME_RE.test(anchorTime)) return { ok: false, error: "invalid_anchor_time" };

  const timezone = b.timezone === undefined ? existing.timezone : str(b.timezone) || "Asia/Tehran";
  if (!TIMEZONE_RE.test(timezone) || !timezoneIsResolvable(timezone)) {
    return { ok: false, error: "invalid_timezone" };
  }

  const localRetention = b.localRetention === undefined ? existing.localRetention : Number(b.localRetention);
  if (!Number.isInteger(localRetention) || localRetention < 1 || localRetention > MAX_RETENTION) {
    return { ok: false, error: "invalid_local_retention" };
  }

  // Directories are OS paths on a machine this server knows nothing about (a
  // Windows drive letter, a POSIX mount, a UNC share) — the filesystem reports
  // a bad one far more accurately at write time than a regex here could, so the
  // only constraint is "a string" (and no NUL, which would truncate).
  for (const key of ["directory", "secondaryDirectory"] as const) {
    if (b[key] !== undefined && typeof b[key] !== "string") {
      return { ok: false, error: `invalid_${key}` };
    }
  }
  const directory = b.directory === undefined ? existing.directory : str(b.directory);
  const secondaryDirectory =
    b.secondaryDirectory === undefined ? existing.secondaryDirectory : str(b.secondaryDirectory);
  if (directory.includes("\0") || secondaryDirectory.includes("\0")) {
    return { ok: false, error: "invalid_directory" };
  }
  if (secondaryDirectory && secondaryDirectory === directory) {
    // Mirroring onto the same directory would double-write and then prune one
    // copy out from under the other; it is a typo, not a configuration.
    return { ok: false, error: "secondary_same_as_primary" };
  }

  const encryptLocal = typeof b.encryptLocal === "boolean" ? b.encryptLocal : existing.encryptLocal;
  const passphrase = b.passphrase === undefined ? existing.passphrase : String(b.passphrase ?? "");
  if (passphrase.includes("\0")) return { ok: false, error: "invalid_passphrase" };

  const rawCloud = b.cloud === undefined ? existing.cloud : (b.cloud as Record<string, unknown>);
  if (typeof rawCloud !== "object" || rawCloud === null || Array.isArray(rawCloud)) {
    return { ok: false, error: "invalid_cloud" };
  }
  const c = rawCloud as Record<string, unknown>;
  const keep = <K extends keyof PlatformBackupCloudConfig>(
    key: K,
    raw: unknown,
    transform: (s: string) => string = (s) => s,
  ): PlatformBackupCloudConfig[K] =>
    (raw === undefined ? existing.cloud[key] : transform(str(raw))) as PlatformBackupCloudConfig[K];

  let prefix = str(c.prefix) || existing.cloud.prefix;
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  if (prefix.startsWith("/")) return { ok: false, error: "invalid_cloud_prefix" };

  const cloud: PlatformBackupCloudConfig = {
    enabled: c.enabled === undefined ? existing.cloud.enabled : Boolean(c.enabled),
    endpoint: keep("endpoint", c.endpoint, (s) => s.replace(/\/+$/, "")),
    region: keep("region", c.region) || "us-east-1",
    bucket: keep("bucket", c.bucket),
    prefix,
    accessKeyId: keep("accessKeyId", c.accessKeyId),
    secretAccessKey:
      c.secretAccessKey === undefined
        ? existing.cloud.secretAccessKey
        : String(c.secretAccessKey ?? ""),
    retention: c.retention === undefined ? existing.cloud.retention : Number(c.retention),
  };
  if (!Number.isInteger(cloud.retention) || cloud.retention < 1 || cloud.retention > MAX_RETENTION) {
    return { ok: false, error: "invalid_cloud_retention" };
  }
  if (cloud.enabled) {
    if (!/^https?:\/\//.test(cloud.endpoint)) return { ok: false, error: "invalid_cloud_endpoint" };
    if (!cloud.bucket) return { ok: false, error: "missing_cloud_bucket" };
    if (!cloud.accessKeyId || !cloud.secretAccessKey) {
      return { ok: false, error: "missing_cloud_credentials" };
    }
  }

  const servingEnabled = b.servingEnabled === undefined ? existing.servingEnabled : Boolean(b.servingEnabled);
  const allowInsecurePeers =
    b.allowInsecurePeers === undefined ? existing.allowInsecurePeers : Boolean(b.allowInsecurePeers);
  const allowPrivatePeers =
    b.allowPrivatePeers === undefined ? existing.allowPrivatePeers : Boolean(b.allowPrivatePeers);

  // Same two rules as the tenant config, and for the same reasons: an empty
  // passphrase would derive an AES key from a publicly known input, and the
  // floor exists so a 3-character "password" is not accepted as encryption.
  // A passphrase that comes from the environment rather than from this form is
  // trusted (the operator put it there deliberately, and its length is not
  // something this request can change) — exactly the way `backupPassphrase`
  // treats `BACKUP_PASSPHRASE`.
  const submitted = passphrase;
  if (cloud.enabled && !(submitted || platformBackupPassphrase({ passphrase: "" }))) {
    return { ok: false, error: "passphrase_required" };
  }
  if ((encryptLocal || cloud.enabled) && submitted && submitted.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: "weak_passphrase" };
  }

  return { ok: true, config: config() };

  function config(): PlatformBackupConfig {
    return {
      enabled,
      intervalHours,
      anchorTime,
      timezone,
      directory,
      secondaryDirectory,
      localRetention,
      encryptLocal,
      passphrase,
      cloud,
      servingEnabled,
      allowInsecurePeers,
      allowPrivatePeers,
    };
  }
}

/**
 * The outbound-network policy this install's config authorizes: an operator who
 * already allowed plain http to a LAN address has declared their LAN intent
 * (the pre-#807 setting), and the explicit `allowPrivatePeers` covers the https
 * LAN case. Metadata/link-local/multicast stay blocked either way.
 */
export function outboundPolicyFor(
  config: Pick<PlatformBackupConfig, "allowInsecurePeers" | "allowPrivatePeers">,
): { allowInsecure: boolean; allowPrivateNetwork: boolean; allowLoopback: boolean } {
  return {
    allowInsecure: config.allowInsecurePeers,
    allowPrivateNetwork: config.allowPrivatePeers || config.allowInsecurePeers,
    // Loopback is never a restore target an operator configured by accident.
    allowLoopback: false,
  };
}

/**
 * The passphrase a run encrypts with: the stored config first, then the
 * deployment's environment (which is what makes a restore possible on a machine
 * whose database is gone — see docs/backup-restore.md's bare-metal section).
 */
export function platformBackupPassphrase(
  config: Pick<PlatformBackupConfig, "passphrase"> | null | undefined,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string {
  const stored = config?.passphrase ?? "";
  if (stored) return stored;
  return (env.PLATFORM_BACKUP_PASSPHRASE || env.BACKUP_PASSPHRASE || "").replace(/\r?\n$/, "");
}

/** What every GET of the config returns: no secret material, only "is it set". */
export interface MaskedPlatformBackupConfig extends Omit<PlatformBackupConfig, "passphrase" | "cloud"> {
  passphrase: "";
  hasPassphrase: boolean;
  cloud: Omit<PlatformBackupCloudConfig, "secretAccessKey"> & {
    secretAccessKey: "";
    hasSecretAccessKey: boolean;
  };
  warnings: string[];
}

export function maskPlatformBackupConfig(config: PlatformBackupConfig, env?: Partial<NodeJS.ProcessEnv>): MaskedPlatformBackupConfig {
  const passphraseSet = Boolean(platformBackupPassphrase(config, env));
  const warnings: string[] = [];
  if (!passphraseSet) {
    warnings.push(
      "No encryption passphrase is set, so artifacts are written in plaintext and cannot be handed to a peer safely.",
    );
  }
  if (config.servingEnabled) {
    warnings.push("This server is currently offering its backup artifacts to any caller holding a valid peer token.");
  }
  if (config.cloud.enabled && !config.cloud.endpoint) {
    warnings.push("Cloud mirroring is enabled without an endpoint; uploads will fail.");
  }
  if (config.allowPrivatePeers) {
    warnings.push(
      "Restoring from private/LAN addresses is allowed. Link-local, loopback and cloud-metadata targets remain blocked.",
    );
  }
  return {
    ...config,
    passphrase: "",
    hasPassphrase: passphraseSet,
    cloud: {
      ...config.cloud,
      secretAccessKey: "",
      hasSecretAccessKey: Boolean(config.cloud.secretAccessKey),
    },
    warnings,
  };
}

/**
 * The console's health line. `directoryConfigured` only feeds the warning copy
 * — a default directory is not a problem, but an operator who set one and then
 * unmounted the drive should see something.
 */
export function platformBackupAlert(config: PlatformBackupConfig, input: {
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
}): BackupAlert {
  return computeBackupAlert({
    enabled: config.enabled,
    cloudEnabled: config.cloud.enabled,
    intervalHours: config.intervalHours,
    ...input,
  });
}

// ---------------------------------------------------------------------------
// The transferable artifact grammar
// ---------------------------------------------------------------------------

/** The name a `.dump.enc`/`.dump` artifact must have to be handed over or restored. */
export function isServeableArtifactName(name: string): boolean {
  return isPlainArtifactName(name) && ARTIFACT_RE.test(name);
}

/** `.dump.enc` (or a name whose bytes carry the POSBKP1 magic — the caller checks bytes). */
export function isEncryptedArtifactName(name: string): boolean {
  return name.endsWith(".enc");
}

/** The object key a platform artifact is mirrored to in the bucket. */
export function platformCloudKeyFor(prefix: string, artifactName: string): string {
  const name = artifactName.endsWith(".enc") ? artifactName : `${artifactName}.enc`;
  return `${prefix}${name}`;
}

/**
 * Newest-first ordering of artifact names by their embedded UTC stamp.
 * Names sort chronologically already, so this is the documented rule rather
 * than a re-derivation — and it is what "no artifact requested ⇒ take the
 * newest" means in one place.
 */
export function newestArtifact<T extends { artifact: string }>(artifacts: T[]): T | null {
  let best: T | null = null;
  for (const candidate of artifacts) {
    if (!best || candidate.artifact > best.artifact) best = candidate;
  }
  return best;
}

/**
 * Which artifact a pull should take: the requested one, or the newest when the
 * operator pressed "restore the latest" without naming it.
 */
export function pickPeerArtifact<T extends { artifact: string }>(
  artifacts: T[],
  requested: string | null | undefined,
): { ok: true; artifact: T } | { ok: false; error: "no_artifacts" | "unknown_artifact" | "unsafe_artifact_name" } {
  if (artifacts.length === 0) return { ok: false, error: "no_artifacts" };
  if (requested === undefined || requested === null || requested === "") {
    const newest = newestArtifact(artifacts);
    return newest ? { ok: true, artifact: newest } : { ok: false, error: "no_artifacts" };
  }
  if (!isServeableArtifactName(requested)) return { ok: false, error: "unsafe_artifact_name" };
  const found = artifacts.find((a) => a.artifact === requested);
  return found ? { ok: true, artifact: found } : { ok: false, error: "unknown_artifact" };
}

// ---------------------------------------------------------------------------
// Peer addresses
// ---------------------------------------------------------------------------

export type PeerUrlResult =
  | { ok: true; url: string; secure: boolean }
  | { ok: false; error: "invalid_url" | "https_required" | "too_long" };

/**
 * Normalize the address an operator pastes for the other server.
 *
 * Accepted: `https://pos.example.com`, `http://192.168.1.20:3000`, a base with
 * a path prefix (`https://example.com/pos`). Rejected: anything with embedded
 * credentials (`https://u:p@host` — a "backup address" that carries a password
 * is either a paste error or a trick), a query or fragment, any other scheme
 * (`file:`, `gopher:`), and plain http unless the config opts into it.
 *
 * The result has no trailing slash, so endpoints are built by concatenation
 * without double-slash surprises.
 */
export function normalizePeerBaseUrl(
  raw: unknown,
  opts: { allowInsecure?: boolean; allowQuery?: boolean } = {},
): PeerUrlResult {
  const value = str(raw);
  if (!value) return { ok: false, error: "invalid_url" };
  if (value.length > 512) return { ok: false, error: "too_long" };
  if (/[\s\0\u200b-\u200f]/.test(value)) return { ok: false, error: "invalid_url" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "invalid_url" };
  }
  if (!url.hostname) return { ok: false, error: "invalid_url" };
  if (url.username || url.password) return { ok: false, error: "invalid_url" };
  // A fragment is never sent to a server, so it is always a mistake in either
  // kind of address. A query is meaningless on a peer *origin* but is exactly
  // what a presigned object URL is made of, so the one-off "restore this file
  // address" flow allows it and the stored-peer flow does not.
  if (url.hash) return { ok: false, error: "invalid_url" };
  if (url.search && !opts.allowQuery) return { ok: false, error: "invalid_url" };
  const secure = url.protocol === "https:";
  if (!secure && !opts.allowInsecure) return { ok: false, error: "https_required" };

  const path = url.pathname.replace(/\/+$/, "");
  if (/\/\/|\.\.\/|%2e/i.test(path)) return { ok: false, error: "invalid_url" };
  // A doubled separator or an encoded dot is a request that does not mean what it looks
  // like; `new URL()` has already collapsed ordinary `.`/`..` segments, so what is
  // stored (and later requested) is the resolved path and never a traversal.
  // The query survives only where it is the point of the address: a presigned object
  // URL *is* its signature, while on a peer origin it can only be a paste of the
  // wrong field.
  const query = opts.allowQuery ? url.search : "";
  const normalized = `${url.protocol}//${url.host}${path}${query}`;
  return { ok: true, url: normalized, secure };
}

/** The two endpoints this product speaks on a peer, relative to its base. */
export const PEER_MANIFEST_PATH = "/api/peer/backup/manifest";
export const PEER_DOWNLOAD_PATH = "/api/peer/backup/download";

export function peerEndpoint(baseUrl: string, subpath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${subpath}`;
}

export function peerManifestUrl(baseUrl: string): string {
  return peerEndpoint(baseUrl, PEER_MANIFEST_PATH);
}

export function peerDownloadUrl(baseUrl: string, artifact: string): string {
  return `${peerEndpoint(baseUrl, PEER_DOWNLOAD_PATH)}?artifact=${encodeURIComponent(artifact)}`;
}

// ---------------------------------------------------------------------------
// Peer tokens
// ---------------------------------------------------------------------------

/**
 * A peer token is a sync token: same `POS1-…` format, same checksum, same
 * paste-resilience, and — because both sides canonicalize before hashing — the
 * two servers agree on the secret even when someone re-typed it by hand.
 */
export type PeerTokenResult =
  | { ok: true; token: string; legacy: false }
  | { ok: false; error: "missing_token" | "bad_prefix" | "bad_length" | "bad_charset" | "bad_checksum" | "too_short" };

export function normalizePeerToken(raw: unknown): PeerTokenResult {
  const value = str(raw);
  if (!value) return { ok: false, error: "missing_token" };
  if (isLegacySyncToken(value)) {
    // A 64-hex secret minted by hand before the POS1 format existed. Still
    // valid on the wire (the sync realm accepts the same shape), but it cannot
    // be *issued* any more.
    return { ok: true, token: value.toLowerCase(), legacy: false };
  }
  const parsed = parseSyncToken(value);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, token: parsed.canonical, legacy: false };
}

/** sha256 of the canonical token — what `platform_backup_tokens.token_hash` holds. */
export function hashPeerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The display tail of a token: enough to tell two apart, useless to a leak. */
export function peerTokenHint(token: string): string {
  const groups = token.split("-").filter(Boolean);
  if (groups.length <= 2) return token.slice(-4);
  return `${groups[0]}…${groups[groups.length - 2]}`;
}

// ---------------------------------------------------------------------------
// The manifest a peer publishes
// ---------------------------------------------------------------------------

export const PEER_APP_ID = "cafe-restaurant-pos";

export interface PeerArtifactManifest {
  artifact: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  encrypted: boolean;
}

export interface PeerManifest {
  /** app id — a manifest from anything else is refused before its numbers are read */
  app: string;
  version: string;
  databaseName: string;
  pgServerMajor: number;
  schemaMigrations: number;
  latestMigration: string;
  businessCount: number;
  artifacts: PeerArtifactManifest[];
}

export type PeerManifestParse = { ok: true; manifest: PeerManifest } | { ok: false; error: "bad_manifest" };

const int = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback);
/**
 * A count, clamped to the only range a count has. A peer sending -5 for its
 * migration count is either buggy or hostile, and either way a negative must not
 * become a number the "is this newer than us?" comparison trusts.
 */
const count = (v: unknown) => Math.max(0, int(v));

/**
 * Parse a peer's manifest response defensively.
 *
 * Everything in here assumes the worst of the remote: it may be an older build
 * of this app, a load balancer's error page, or somebody's hostile stand-in.
 * So the shape is checked field by field, the artifact names are re-validated
 * against the local artifact grammar, and unknown fields are dropped rather
 * than carried forward.
 */
export function parsePeerManifest(json: unknown): PeerManifestParse {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "bad_manifest" };
  const m = json as Record<string, unknown>;
  if (m.app !== PEER_APP_ID) return { ok: false, error: "bad_manifest" };
  if (!Array.isArray(m.artifacts)) return { ok: false, error: "bad_manifest" };
  const artifacts: PeerArtifactManifest[] = [];
  for (const raw of m.artifacts) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "bad_manifest" };
    const a = raw as Record<string, unknown>;
    if (typeof a.artifact !== "string" || !isServeableArtifactName(a.artifact)) {
      return { ok: false, error: "bad_manifest" };
    }
    // Case-insensitive on purpose: providers and shell one-liners print either,
    // and the comparison below is over the lowercase hex either way. Shape is
    // still strict, because a truncated digest is exactly what a bad download
    // looks like before it looks like a corrupted database.
    if (typeof a.sha256 === "string" && !/^[0-9a-f]{64}$/i.test(a.sha256)) {
      return { ok: false, error: "bad_manifest" };
    }
    const createdAt = typeof a.createdAt === "string" ? a.createdAt : "";
    if (createdAt && Number.isNaN(new Date(createdAt).getTime())) return { ok: false, error: "bad_manifest" };
    const sizeBytes = int(a.sizeBytes, 0);
    artifacts.push({
      artifact: a.artifact,
      sizeBytes: sizeBytes < 0 ? 0 : sizeBytes,
      sha256: typeof a.sha256 === "string" ? a.sha256.toLowerCase() : "",
      createdAt,
      encrypted: Boolean(a.encrypted),
    });
  }
  return {
    ok: true,
    manifest: {
      app: PEER_APP_ID,
      version: typeof m.version === "string" ? m.version.slice(0, 64) : "",
      databaseName: typeof m.databaseName === "string" ? m.databaseName.slice(0, 128) : "",
      pgServerMajor: count(m.pgServerMajor),
      schemaMigrations: count(m.schemaMigrations),
      latestMigration: typeof m.latestMigration === "string" ? m.latestMigration.slice(0, 256) : "",
      businessCount: count(m.businessCount),
      artifacts,
    },
  };
}

export type PeerManifestCheck = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * May this install restore that manifest?
 *
 * The hard rules are about *schema*, because a restore replaces the database
 * wholesale and the code running on top of it afterwards is this install's:
 *
 *   • the manifest must describe this app (`not_this_app`);
 *   • it must carry at least one artifact (`no_artifacts`);
 *   • it must be restorable *by this build*: an artifact dumped by a newer
 *     schema would land tables this code has no migrations for, and a dump from
 *     a Postgres major newer than the target's cannot be read by an older
 *     `pg_restore` at all (`pg_restore_16` on a dump from 18 fails outright).
 *
 * The soft ones come back as warnings the console shows before the operator
 * presses the dangerous button: a *lower* migration count is legal (this is a
 * downgrade of the tenant data, which is what a restore is for) but it means
 * the schema rolls back; an encrypted artifact with no passphrase on this
 * server will fail at decrypt time; and a plain-http peer is carrying the whole
 * ledger unencrypted.
 */
export function checkPeerManifest(
  manifest: PeerManifest,
  local: {
    schemaMigrations: number;
    pgServerMajor: number;
    hasPassphrase: boolean;
    allowInsecurePeers?: boolean;
    secureTransport: boolean;
  },
  requestedArtifact?: string,
): PeerManifestCheck {
  if (manifest.app !== PEER_APP_ID) return { ok: false, error: "not_this_app" };
  if (manifest.artifacts.length === 0) return { ok: false, error: "no_artifacts" };

  const chosen = (() => {
    const all = manifest.artifacts;
    if (requestedArtifact) return all.find((a) => a.artifact === requestedArtifact) ?? null;
    let best: PeerArtifactManifest | null = null;
    for (const candidate of all) if (!best || candidate.artifact > best.artifact) best = candidate;
    return best;
  })();
  if (requestedArtifact && !chosen) return { ok: false, error: "unknown_artifact" };

  if (manifest.schemaMigrations > local.schemaMigrations) return { ok: false, error: "newer_schema" };
  if (manifest.pgServerMajor > 0 && local.pgServerMajor > 0 && manifest.pgServerMajor > local.pgServerMajor) {
    return { ok: false, error: "newer_postgres" };
  }

  const warnings: string[] = [];
  if (manifest.schemaMigrations < local.schemaMigrations) {
    warnings.push(
      `This backup predates ${local.schemaMigrations - manifest.schemaMigrations} migration(s) of this server — restoring rolls the schema back as well as the data.`,
    );
  }
  if (chosen?.encrypted && !local.hasPassphrase) {
    warnings.push("The artifact is encrypted and this server has no passphrase stored; enter one to restore it.");
  }
  if (!local.secureTransport && local.allowInsecurePeers) {
    warnings.push("This peer is reached over plain http: the backup crosses the network unencrypted.");
  }
  if (manifest.businessCount === 0) {
    warnings.push("The source database reports no businesses — double-check this is the server you meant.");
  }
  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// Download limits
// ---------------------------------------------------------------------------

/**
 * The cap on a downloaded artifact, so a hostile or misconfigured peer cannot
 * fill this server's disk (or its RAM) by "having" a 500 GiB backup. A whole
 * POS database dump is normally tens of megabytes, so the default is already
 * generous; `PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES` raises it for big installs.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function resolveMaxDownloadBytes(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_DOWNLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_048_576) return DEFAULT_MAX_DOWNLOAD_BYTES;
  return Math.floor(parsed);
}

export function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A manifest that declared no checksum cannot vouch for a body, and a body that
 * disagrees with the one it did declare is a corrupt or substituted download —
 * both stop the restore. Empty/absent `expected` is only tolerated when the
 * peer published nothing to check against (see `parsePeerManifest`).
 */
export function checksumAcceptable(data: Buffer, expected: string): boolean {
  if (!expected) return false;
  return sha256Of(data) === expected.toLowerCase();
}

// ---------------------------------------------------------------------------
// Resolving a restore request (before any of it runs)
// ---------------------------------------------------------------------------

/**
 * The phrase an operator must type to apply a whole-system restore. Deliberately
 * Persian, deliberate, and not something that survives a stray Enter: the
 * action drops and recreates the production database.
 */
export const PLATFORM_RESTORE_CONFIRM_PHRASE = "بازگردانی کامل سیستم";

export type RestoreSource = "local" | "cloud" | "peer" | "url";

export type RestorePlan =
  | {
      ok: true;
      mode: "verify" | "apply";
      source: RestoreSource;
      /** the bare artifact name (never a path, never a key) */
      artifact: string;
      /**
       * Only for source="cloud": the full S3 object key, server-derived or
       * server-validated against the configured prefix (issue #807). The
       * browser never gets to name an arbitrary key.
       */
      objectKey: string | null;
      peerId: string | null;
      /** only for source="url": a one-off address, not a stored peer */
      url: string | null;
      /** an operator-supplied passphrase for this attempt only; never stored */
      passphrase: string;
    }
  | { ok: false; error: string };

/**
 * The object key a cloud artifact is restored from, validated against the
 * configured prefix (issue #807).
 *
 * The audit found that `listPlatformCloudArtifacts()` returned full S3 keys
 * (`platform-backups/pos-backup-….dump.enc`) while the restore plan required a
 * plain name without `/` — so prefixed cloud artifacts could never be restored
 * from the UI at all, and "fixing" it by trusting the key from the browser
 * would have let a caller name any object in the bucket. This resolves the
 * contradiction: the key is *checked* against the prefix and the artifact
 * grammar, and when the caller supplied only a name the key is derived from the
 * prefix rather than taken from the request.
 */
export function resolveCloudObjectKey(
  raw: { objectKey?: unknown; artifact?: unknown },
  prefix: string,
  opts: { allowedArtifacts?: ReadonlySet<string> } = {},
): { ok: true; objectKey: string; artifact: string } | { ok: false; error: string } {
  const normalizedPrefix = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  const rawKey = str(raw.objectKey);
  const rawArtifact = str(raw.artifact);

  let key = rawKey;
  if (!key) {
    // Backward compatible: a request that names only the artifact gets the key
    // the prefix implies. The artifact must still be a real artifact name.
    if (!rawArtifact) return { ok: false, error: "missing_artifact" };
    if (!isServeableArtifactName(rawArtifact)) return { ok: false, error: "unsafe_artifact_name" };
    key = `${normalizedPrefix}${rawArtifact}`;
  }
  if (key.length > 1024) return { ok: false, error: "invalid_object_key" };
  if (key.startsWith("/") || key.includes("\\") || key.split("/").some((segment) => segment === ".." || segment === ".")) {
    return { ok: false, error: "invalid_object_key" };
  }
  if (normalizedPrefix && !key.startsWith(normalizedPrefix)) {
    return { ok: false, error: "object_key_outside_prefix" };
  }
  const suffix = normalizedPrefix ? key.slice(normalizedPrefix.length) : key;
  // Exactly one path segment after the prefix: an artifact, not a sub-path.
  if (!suffix || suffix.includes("/") || !isServeableArtifactName(suffix)) {
    return { ok: false, error: "unsafe_artifact_name" };
  }
  if (rawArtifact && rawArtifact !== suffix) return { ok: false, error: "artifact_key_mismatch" };
  if (opts.allowedArtifacts && !opts.allowedArtifacts.has(suffix)) {
    return { ok: false, error: "unknown_artifact" };
  }
  return { ok: true, objectKey: key, artifact: suffix };
}

/**
 * Turn POST /api/platform/backup/restore's body into an exact plan, or a
 * refusal. Pure on purpose: every branch here is unit-tested without a
 * database, a filesystem, or a second server.
 *
 * The ordering is the security order, not the convenience order: confirm the
 * destructive intent first (so an unconfirmed `apply` cannot reach any of the
 * rest), then the artifact grammar (so nothing malformed approaches a path or a
 * URL), then the address itself.
 */
export function resolveRestorePlan(
  body: unknown,
  opts: {
    allowInsecurePeers?: boolean;
    knownPeerIds?: ReadonlySet<string>;
    /** the configured cloud prefix; required so a cloud source can be resolved */
    cloudPrefix?: string;
    /** artifact names the server knows about (from its own listing/run history) */
    knownCloudArtifacts?: ReadonlySet<string>;
  } = {},
): RestorePlan {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "not_an_object" };
  }
  const b = body as Record<string, unknown>;

  const mode: "verify" | "apply" = b.apply === true ? "apply" : "verify";
  if (mode === "apply") {
    const confirm = typeof b.confirm === "string" ? b.confirm.trim() : "";
    if (confirm !== PLATFORM_RESTORE_CONFIRM_PHRASE) return { ok: false, error: "confirmation_required" };
  }

  const rawSource = str(b.source) || "peer";
  if (!["local", "cloud", "peer", "url"].includes(rawSource)) return { ok: false, error: "invalid_source" };
  const source = rawSource as RestoreSource;

  // For source="url" the *address itself* names the file, so the artifact is
  // taken from its basename rather than from the body — an operator pasting a
  // link cannot then also mistype a second, different name for what it points
  // at, and a body that claims a different artifact than the URL ends in is
  // refused outright instead of quietly restoring one thing while logging
  // another.
  let artifact = str(b.artifact);
  if (source === "url") {
    const fromUrl = artifactNameFromUrl(str(b.url));
    if (!fromUrl) return { ok: false, error: "url_has_no_artifact_name" };
    if (artifact && artifact !== fromUrl) return { ok: false, error: "artifact_url_mismatch" };
    artifact = fromUrl;
  }
  if (!artifact) return { ok: false, error: "missing_artifact" };
  // The name goes into a path on this machine and into a query string on
  // someone else's, so it has to be one of ours and nothing else.
  if (!isServeableArtifactName(artifact)) return { ok: false, error: "unsafe_artifact_name" };

  const passphrase = typeof b.passphrase === "string" ? b.passphrase : "";
  if (passphrase.includes("\0")) return { ok: false, error: "invalid_passphrase" };

  // Cloud identity is explicit (issue #807): the artifact *and* the object key
  // travel separately, and the key is validated against the configured prefix
  // rather than trusted. A request naming only the artifact still works — the
  // key is derived — but a request naming an arbitrary key outside the prefix
  // is refused before any S3 credential is used.
  let objectKey: string | null = null;
  if (source === "cloud") {
    const resolved = resolveCloudObjectKey(
      { objectKey: b.objectKey, artifact },
      opts.cloudPrefix ?? "",
      opts.knownCloudArtifacts ? { allowedArtifacts: opts.knownCloudArtifacts } : {},
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    objectKey = resolved.objectKey;
    artifact = resolved.artifact;
  }

  let peerId: string | null = null;
  let url: string | null = null;
  if (source === "peer") {
    const candidate = str(b.peerId).toLowerCase();
    if (!candidate) return { ok: false, error: "missing_peer" };
    if (!isPeerId(candidate)) return { ok: false, error: "invalid_peer" };
    // The route knows which peer ids exist; refusing an unknown one here keeps
    // "restore from a peer" from becoming "make an authenticated request to any
    // URL in the body" for a caller who guesses a uuid.
    if (opts.knownPeerIds && !opts.knownPeerIds.has(candidate)) {
      return { ok: false, error: "peer_not_found" };
    }
    peerId = candidate;
  }
  if (source === "url") {
    const resolved = normalizePeerBaseUrl(b.url, {
      allowInsecure: opts.allowInsecurePeers,
      allowQuery: true,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    url = resolved.url;
  }

  return { ok: true, mode, source, artifact, objectKey, peerId, url, passphrase };
}

/**
 * The last path segment of an address, decoded — the artifact name a bare
 * download URL implies. Returns null when the address has no path (a peer
 * origin, not a file) or when the segment is not an artifact name; the caller
 * never has to reason about separators, because it gets a name or nothing.
 */
export function artifactNameFromUrl(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    return null;
  }
  const segment = decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "");
  return isServeableArtifactName(segment) ? segment : null;
}

/**
 * A `platform_backup_peers.id` — a uuid, and nothing else. The point of the
 * strict shape is that a restore body can only ever name a peer row this
 * server already has, so "restore from peer" cannot be turned into "make an
 * authenticated request to this URL I just typed" by way of the peer table.
 */
export function isPeerId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.toLowerCase());
}
