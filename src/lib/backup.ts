/**
 * Phase 10 — backup system: the framework-free half.
 *
 * A backup is a `pg_dump --format=custom` of the WHOLE local database,
 * written to local disk on a schedule (and optionally mirrored to a second
 * local directory, e.g. a mounted USB drive/NAS), then encrypted and
 * uploaded to S3-compatible cloud storage. This module holds everything
 * about that pipeline that doesn't touch the database or the filesystem:
 * config validation, schedule computation (wall-clock, in the location's
 * timezone), artifact naming, retention selection, staleness/alerting, and
 * the encryption format for cloud artifacts.
 *
 * Encrypted artifact format (`.dump.enc`):
 *   magic "POSBKP1\0" (8) | scrypt salt (16) | AES-256-GCM IV (12) |
 *   ciphertext | GCM auth tag (16)
 * The key is derived from the Owner's passphrase with scrypt — the cloud
 * provider only ever stores ciphertext (backups contain the full financial
 * ledger and customer data). Losing the passphrase makes cloud artifacts
 * unrecoverable; local artifacts are plaintext and stay on-site.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";

/** How often the scheduler wakes up to check whether a backup slot passed (ms). */
export const BACKUP_TICK_INTERVAL_MS = 60 * 1000;
/** Wait this long before re-trying a failed cloud upload of the same artifact (ms). */
export const CLOUD_RETRY_MS = 10 * 60 * 1000;
/** Back off this long before re-running a scheduled local backup whose last run failed (ms). */
export const LOCAL_RETRY_MS = 10 * 60 * 1000;
/** Recent-runs page size for the dashboard history table. */
export const BACKUP_RUNS_SHOWN = 20;

export const ALLOWED_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const MAX_RETENTION = 365;

export interface BackupCloudConfig {
  enabled: boolean;
  /** S3-compatible endpoint, e.g. https://s3.ir-thr-at1.arvanstorage.ir or a LAN MinIO */
  endpoint: string;
  region: string;
  bucket: string;
  /** object key prefix, normalized to end with "/" (empty = bucket root) */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** encryption passphrase for `.dump.enc` artifacts — never sent to the provider */
  passphrase: string;
  /** keep this many newest objects under the prefix */
  retention: number;
}

export interface BackupConfig {
  /** master switch for scheduled local backups (manual "backup now" always works) */
  enabled: boolean;
  /** run every N hours (24 = nightly) at slots anchored on `anchorTime` */
  intervalHours: number;
  /** "HH:MM" wall time in the location's timezone; slots are anchor + k·interval */
  anchorTime: string;
  /** keep this many newest artifacts in the local backup directory */
  localRetention: number;
  /**
   * Where artifacts are written. Empty means "wherever BACKUP_DIR / the
   * built-in default points" — which is every install that predates the
   * standalone desktop app, so leaving it empty changes nothing. The desktop
   * wizard sets it from a real OS folder dialog.
   */
  directory: string;
  /** encryption passphrase for `.dump.enc` artifacts — never sent to the cloud */
  passphrase?: string;
  /** whether local and USB artifacts are encrypted (default true) */
  encryptLocal?: boolean;
  cloud: BackupCloudConfig;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  intervalHours: 24,
  anchorTime: "03:30",
  localRetention: 14,
  directory: "",
  passphrase: "",
  encryptLocal: true,
  cloud: {
    enabled: false,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "pos-backups/",
    accessKeyId: "",
    secretAccessKey: "",
    passphrase: "",
    retention: 30,
  },
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_PASSPHRASE_LENGTH = 8;

export type BackupConfigValidation =
  | { ok: true; config: BackupConfig }
  | { ok: false; error: string };

/** Normalize + validate an Owner-submitted config (PUT /api/backup/config body). */
export function validateBackupConfig(body: unknown): BackupConfigValidation {
  if (typeof body !== "object" || body === null) return { ok: false, error: "not_an_object" };
  const b = body as Record<string, unknown>;

  const enabled = Boolean(b.enabled);
  const intervalHours = Number(b.intervalHours);
  if (!(ALLOWED_INTERVAL_HOURS as readonly number[]).includes(intervalHours)) {
    return { ok: false, error: "invalid_interval" };
  }
  const anchorTime = typeof b.anchorTime === "string" ? b.anchorTime : "";
  if (!TIME_RE.test(anchorTime)) return { ok: false, error: "invalid_anchor_time" };
  const localRetention = Number(b.localRetention);
  if (!Number.isInteger(localRetention) || localRetention < 1 || localRetention > MAX_RETENTION) {
    return { ok: false, error: "invalid_local_retention" };
  }
  // No shape constraint beyond "a string": the destination is an OS path on a
  // machine we know nothing about (a Windows drive letter, a POSIX mount, a
  // UNC share), and the filesystem reports a bad one at write time far more
  // accurately than a regex here could.
  if (b.directory !== undefined && typeof b.directory !== "string") {
    return { ok: false, error: "invalid_directory" };
  }
  const directory = typeof b.directory === "string" ? b.directory.trim() : "";
  const passphrase = typeof b.passphrase === "string" ? b.passphrase : "";
  const encryptLocal = typeof b.encryptLocal === "boolean" ? b.encryptLocal : true;

  const rawCloud = (b.cloud ?? {}) as Record<string, unknown>;
  if (typeof rawCloud !== "object" || rawCloud === null) return { ok: false, error: "invalid_cloud" };
  const cloudEnabled = Boolean(rawCloud.enabled);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let prefix = str(rawCloud.prefix);
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  if (prefix.startsWith("/")) return { ok: false, error: "invalid_cloud_prefix" };
  const cloud: BackupCloudConfig = {
    enabled: cloudEnabled,
    endpoint: str(rawCloud.endpoint).replace(/\/+$/, ""),
    region: str(rawCloud.region) || "us-east-1",
    bucket: str(rawCloud.bucket),
    prefix,
    accessKeyId: str(rawCloud.accessKeyId),
    secretAccessKey: str(rawCloud.secretAccessKey),
    passphrase: typeof rawCloud.passphrase === "string" ? rawCloud.passphrase : "",
    retention: Number(rawCloud.retention),
  };
  if (!Number.isInteger(cloud.retention) || cloud.retention < 1 || cloud.retention > MAX_RETENTION) {
    return { ok: false, error: "invalid_cloud_retention" };
  }
  if (cloudEnabled) {
    if (!/^https?:\/\//.test(cloud.endpoint)) return { ok: false, error: "invalid_cloud_endpoint" };
    if (!cloud.bucket) return { ok: false, error: "missing_cloud_bucket" };
    if (!cloud.accessKeyId || !cloud.secretAccessKey) {
      return { ok: false, error: "missing_cloud_credentials" };
    }
  }

  // The passphrase floor applies to whichever one is populated.
  const resolvedPassphrase = passphrase || cloud.passphrase;

  // Cloud upload cannot proceed without a real passphrase. Accepting an empty
  // one here would let `runCloudUpload` derive its AES key from "" via scrypt
  // and ship an artifact anyone who obtains it can decrypt — the whole ledger
  // and customer list, off-site, behind a key that is public knowledge.
  //
  // Deliberately *not* applied to `encryptLocal`: that flag defaults to on and
  // documents a plaintext fallback (see Phase-24 §5 "Decisions"), so requiring
  // a passphrase for it would refuse to save any config on the installs that
  // have never set one, and their artifacts never leave the premises anyway.
  // `getBackupConfigMasked` raises the plaintext warning for that case.
  if (cloudEnabled && !resolvedPassphrase) {
    return { ok: false, error: "passphrase_required" };
  }
  if ((encryptLocal || cloudEnabled) && resolvedPassphrase && resolvedPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: "weak_passphrase" };
  }

  return {
    ok: true,
    config: { enabled, intervalHours, anchorTime, localRetention, directory, passphrase, encryptLocal, cloud },
  };
}

export function backupPassphrase(config: BackupConfig): string {
  if (config.passphrase) return config.passphrase;
  if (config.cloud.passphrase) return config.cloud.passphrase;
  return process.env.BACKUP_PASSPHRASE || "";
}

// ---------------------------------------------------------------------------
// Which connection pg_dump runs with
// ---------------------------------------------------------------------------

/**
 * Connection string `pg_dump` runs with — deliberately not always the app's.
 *
 * The server process connects as the restricted `pos_app` role (NOSUPERUSER,
 * NOBYPASSRLS) so Phase 12's RLS policies actually apply to it. pg_dump runs
 * with `row_security = off`, and Postgres refuses that for a role which can't
 * bypass RLS on a FORCE-ROW-LEVEL-SECURITY table (migration 0021), failing the
 * whole dump on its first COPY: «query would be affected by row-level security
 * policy for table "accounts"». A whole-database dump therefore has to use the
 * privileged (migrating/owner) connection, which the container entrypoint and
 * the desktop launcher hand over as BACKUP_DATABASE_URL. DATABASE_URL is the
 * fallback — in a dev shell it *is* the owner connection.
 *
 * Passing pg_dump `--enable-row-security` instead would exit 0 and dump only
 * the rows the role can see, which with no tenant scope set is none of them.
 * A silently empty backup is far worse than a failing one, so it isn't used.
 */
export function dumpDatabaseUrl(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const url = env.BACKUP_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) throw new Error("neither BACKUP_DATABASE_URL nor DATABASE_URL is set");
  return url;
}

// ---------------------------------------------------------------------------
// Artifact naming
// ---------------------------------------------------------------------------
//
// Issue #807 — an artifact name carries three things beyond the timestamp:
//
//   • a **scope tag** (the short, stable business/installation id) so two
//     backup scopes sharing one directory can never collide, and so retention
//     for one scope can never prune another's files;
//   • a **run id** (8 hex chars of the run's uuid) so two runs in the same
//     second — a scheduled tick racing a manual click, two processes on a
//     shared volume — still produce different paths;
//   • a **format** marker: `.dump` for a physical `pg_dump` artifact,
//     `.sql` for a per-tenant *logical* snapshot. Central deployments may only
//     ever write the logical one (see backup-policy.ts).
//
// Legacy names (`pos-backup-YYYYMMDD-HHMMSS.dump`) still parse: their scope is
// `null`, which the retention selector treats as belonging to the site's own
// scope so an upgraded install does not orphan its existing history.

/**
 * Matches an artifact name (or an object key ending in one), capturing scope,
 * UTC stamp, optional run id, format and the `.enc` marker. Deliberately not
 * anchored at the start: cloud object keys (`platform-backups/pos-backup-…`)
 * are matched against it to select what to prune.
 */
export const ARTIFACT_RE =
  /pos-backup(?:-([a-z0-9]{1,16}))?-(\d{8})-(\d{6})(?:-([0-9a-f]{8}))?\.(dump|sql)(\.enc)?$/;

export type ArtifactFormat = "dump" | "sql";

export interface ParsedArtifact {
  /** the name itself (or the object key's artifact suffix) */
  name: string;
  /** short stable scope tag, or null for a pre-#807 name */
  scope: string | null;
  /** UTC stamp embedded in the name, ISO-8601 seconds */
  timestamp: string | null;
  /** the run uuid's short form, or null for a pre-#807 name */
  runId: string | null;
  format: ArtifactFormat;
  encrypted: boolean;
}

/** A short, stable, filesystem-safe tag for a backup scope (a business id). */
export function artifactScopeTag(scopeId: string): string {
  const clean = scopeId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.slice(0, 16) || "default";
}

/** Eight hex characters of a run uuid — collision-resistant inside one second. */
export function artifactRunToken(runId: string): string {
  const clean = runId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (clean.slice(0, 8) || "00000000").padEnd(8, "0");
}

export interface MakeArtifactNameOptions {
  /** short scope tag (see `artifactScopeTag`); omitted = a legacy-style name */
  scope?: string | null;
  /** the run's uuid; omitted = none, which is only useful for tests/fixtures */
  runId?: string | null;
  format?: ArtifactFormat;
  /** append `.enc` — what every encrypted artifact's name must carry */
  encrypted?: boolean;
}

/** `pos-backup[-<scope>]-YYYYMMDD-HHMMSS[-<run>].<dump|sql>[.enc]` — UTC stamp, so names sort chronologically. */
export function makeArtifactName(now: Date = new Date(), opts: MakeArtifactNameOptions = {}): string {
  const iso = now.toISOString(); // 2026-07-21T03:30:05.123Z
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  const scope = opts.scope ? `-${artifactScopeTag(opts.scope)}` : "";
  const run = opts.runId ? `-${artifactRunToken(opts.runId)}` : "";
  const format = opts.format ?? "dump";
  return `pos-backup${scope}-${stamp}${run}.${format}${opts.encrypted ? ".enc" : ""}`;
}

/** Everything the artifact grammar can tell about a name/key, or null if it isn't one. */
export function parseArtifactName(name: string): ParsedArtifact | null {
  const m = ARTIFACT_RE.exec(name);
  if (!m) return null;
  const [, scope, d, t, runId, format, enc] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  const parsed = new Date(iso);
  const timestamp = Number.isNaN(parsed.getTime()) || parsed.toISOString() !== `${iso.slice(0, 19)}.000Z` ? null : iso;
  return {
    name,
    scope: scope ?? null,
    timestamp,
    runId: runId ?? null,
    format: format as ArtifactFormat,
    encrypted: Boolean(enc),
  };
}

/** ISO timestamp embedded in an artifact name/key, or null if it isn't one. */
export function parseArtifactTimestamp(name: string): string | null {
  return parseArtifactName(name)?.timestamp ?? null;
}

/** A physical whole-database dump (`.dump`), as opposed to a logical tenant snapshot. */
export function isPhysicalArtifactName(name: string): boolean {
  return parseArtifactName(name)?.format === "dump";
}

/** A per-tenant logical snapshot (`.sql`) — the only artifact central may write. */
export function isLogicalArtifactName(name: string): boolean {
  return parseArtifactName(name)?.format === "sql";
}

/** Object key an artifact is uploaded under (encrypted, hence `.enc`). */
export function cloudKeyFor(prefix: string, artifactName: string): string {
  const name = artifactName.endsWith(".enc") ? artifactName : `${artifactName}.enc`;
  return `${prefix}${name}`;
}

/**
 * Whether `name` is a bare local artifact file name and not a path.
 *
 * The restore route takes the artifact to restore from the request body, and
 * local artifacts live flat in the backup directory — so anything carrying a
 * path separator (and therefore any `..` segment) is a traversal attempt rather
 * than a backup, and must never reach `path.join(backupDir, name)`. Checked on
 * both separators regardless of platform: the string arrives over HTTP, so a
 * `\` means a separator to a Windows host whatever the server's own `path.sep`
 * is.
 *
 * Only the local branch needs this — a cloud artifact is an S3 object key,
 * where the configured prefix makes a `/` legitimate and there is no
 * filesystem to escape.
 */
export function isPlainArtifactName(name: string): boolean {
  return name.length > 0 && !/[\\/]/.test(name) && name !== "." && name !== "..";
}

// ---------------------------------------------------------------------------
// Scheduling — wall-clock slots in the location's timezone
// ---------------------------------------------------------------------------

interface WallClock {
  /** local calendar date, YYYY-MM-DD */
  date: string;
  /** minutes since local midnight */
  minutes: number;
}

/** An instant expressed as wall-clock time in `timeZone` (Intl, no tz math by hand). */
export function toWallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function anchorMinutes(anchorTime: string): number {
  const m = TIME_RE.exec(anchorTime);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 210; // fall back to 03:30
}

function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The most recent schedule slot at or before `now` (wall clock). Slots each
 * day are anchor + k·interval for k = 0.. while under 24h; if `now` is
 * before the day's first slot, the answer is yesterday's last slot.
 */
export function latestSlotBefore(nowWall: WallClock, anchorTime: string, intervalHours: number): WallClock {
  const anchor = anchorMinutes(anchorTime);
  const step = intervalHours * 60;
  if (nowWall.minutes >= anchor) {
    const k = Math.floor((nowWall.minutes - anchor) / step);
    return { date: nowWall.date, minutes: anchor + k * step };
  }
  const lastK = Math.floor((24 * 60 - 1 - anchor) / step);
  return { date: previousDate(nowWall.date), minutes: anchor + lastK * step };
}

function compareWall(a: WallClock, b: WallClock): number {
  return a.date === b.date ? a.minutes - b.minutes : a.date.localeCompare(b.date);
}

/**
 * Should the scheduler start a backup now? True when the latest slot at or
 * before `now` hasn't been covered by any run started at/after it. Comparing
 * wall clocks (not instants) keeps this exact across any timezone offset,
 * including half-hour ones like Asia/Tehran (+03:30).
 */
export function isBackupDue(
  lastStartedAt: string | Date | null,
  now: Date,
  config: Pick<BackupConfig, "enabled" | "anchorTime" | "intervalHours">,
  timeZone: string,
): boolean {
  if (!config.enabled) return false;
  const slot = latestSlotBefore(toWallClock(now, timeZone), config.anchorTime, config.intervalHours);
  if (!lastStartedAt) return true;
  const last = new Date(lastStartedAt);
  if (Number.isNaN(last.getTime())) return true;
  return compareWall(toWallClock(last, timeZone), slot) < 0;
}

/**
 * Whether a slot that a *failed* run "covered" should be retried.
 *
 * `isBackupDue` keys off when a run *started*, so a run that started inside
 * the slot and then failed would otherwise silence the scheduler until the
 * next slot — a transient pg_dump failure (a momentary lock, a disk hiccup)
 * would push the RPO out by a full interval. This retries such a run after
 * LOCAL_RETRY_MS, so a persistently broken dump is neither hammered nor
 * re-notified every tick, and a fresh slot that has genuinely passed is left
 * to `isBackupDue` (that is the "run a new backup" case, not a retry).
 */
export function isFailedRunRetryDue(
  lastStartedAt: string | Date | null,
  lastStatus: string | null,
  now: Date,
  config: Pick<BackupConfig, "enabled" | "anchorTime" | "intervalHours">,
  timeZone: string,
): boolean {
  if (!config.enabled) return false;
  if (lastStatus !== "failed") return false;
  if (isBackupDue(lastStartedAt, now, config, timeZone)) return false;
  const last = new Date(lastStartedAt ?? "");
  if (Number.isNaN(last.getTime())) return false;
  return now.getTime() - last.getTime() >= LOCAL_RETRY_MS;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Which artifacts to delete, keeping the `keep` newest. Accepts local file
 * names or full object keys; anything that isn't a backup artifact is left
 * alone (never delete files we didn't write). Names sort chronologically
 * because the stamp is zero-padded UTC.
 */
export function selectPrunable(names: string[], keep: number): string[] {
  const artifacts = names
    .filter((n) => ARTIFACT_RE.test(n))
    .sort((a, b) => (ARTIFACT_RE.exec(b)![0] < ARTIFACT_RE.exec(a)![0] ? -1 : 1));
  return artifacts.slice(Math.max(0, keep));
}

/**
 * Retention inside one scope (issue #807).
 *
 * `selectPrunable` answers "which of these files may be deleted", not "which of
 * these files are *ours*" — and two scopes sharing a directory (a NAS holding
 * several site installs, or a site directory that also received artifacts
 * before scoping existed) would let one scope's retention delete another's only
 * copy. This selector is the fix: a name is prunable only when its parsed scope
 * tag equals `scope`, or when it is a legacy (unscoped) name and `adoptUnscoped`
 * says the caller owns those (the site's own directory does; the platform's
 * never does).
 */
export function selectPrunableInScope(
  names: string[],
  keep: number,
  scope: string,
  opts: { adoptUnscoped?: boolean } = {},
): string[] {
  const tag = artifactScopeTag(scope);
  const mine = names.filter((name) => {
    const parsed = parseArtifactName(name);
    if (!parsed) return false;
    if (parsed.scope === null) return Boolean(opts.adoptUnscoped);
    return parsed.scope === tag;
  });
  return selectPrunable(mine, keep);
}

/**
 * A free artifact path: `makeName()` retried with a fresh run token until the
 * directory has no such file. Two concurrent runs cannot produce the same name
 * (the run token is part of it), and this closes the remaining case — a
 * leftover file from a manual copy — rather than letting `rename` overwrite a
 * copy somebody kept. Retries regenerate the whole name so the result always
 * still matches `ARTIFACT_RE` (a `-1` suffix would silently drop it out of
 * retention and out of the restorable list).
 */
export async function reserveArtifactName(
  dir: string,
  makeName: () => string,
  exists: (filePath: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = makeName();
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error("artifact_name_collision");
}

// ---------------------------------------------------------------------------
// Health / alerting
// ---------------------------------------------------------------------------

/**
 * A backup is stale when no success landed within one interval plus a grace
 * period (a quarter interval, at least an hour) — the "expected window" the
 * dashboard alert fires in. Nightly (24h) ⇒ alert after 30h without success.
 */
export function backupStaleAfterMs(intervalHours: number): number {
  const graceMs = Math.max(1, intervalHours / 4) * 60 * 60 * 1000;
  return intervalHours * 60 * 60 * 1000 + graceMs;
}

export function isBackupStale(
  lastSuccessAt: string | Date | null,
  intervalHours: number,
  now: Date = new Date(),
): boolean {
  if (!lastSuccessAt) return true;
  const t = new Date(lastSuccessAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > backupStaleAfterMs(intervalHours);
}

export type BackupAlert =
  | { level: "ok"; reason: "ok" }
  | { level: "warning"; reason: "disabled" }
  | { level: "error"; reason: "local_failed" | "local_stale" | "cloud_failed" | "cloud_stale" };

export interface BackupAlertInput {
  enabled: boolean;
  cloudEnabled: boolean;
  intervalHours: number;
  localLastSuccessAt: string | null;
  /** error of the newest local run, null when it succeeded / none ran */
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
}

/**
 * The single alert the Owner dashboard surfaces. A failed *latest* run alerts
 * immediately (don't wait out the window — the failure already happened);
 * otherwise silence past the expected window alerts as stale. Cloud only
 * counts while cloud backup is enabled.
 */
export function computeBackupAlert(input: BackupAlertInput, now: Date = new Date()): BackupAlert {
  if (!input.enabled) return { level: "warning", reason: "disabled" };
  if (input.localLastError !== null) return { level: "error", reason: "local_failed" };
  if (isBackupStale(input.localLastSuccessAt, input.intervalHours, now)) {
    return { level: "error", reason: "local_stale" };
  }
  if (input.cloudEnabled) {
    if (input.cloudLastError !== null) return { level: "error", reason: "cloud_failed" };
    if (isBackupStale(input.cloudLastSuccessAt, input.intervalHours, now)) {
      return { level: "error", reason: "cloud_stale" };
    }
  }
  return { level: "ok", reason: "ok" };
}

// ---------------------------------------------------------------------------
// Encryption for cloud artifacts
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from("POSBKP1\0", "latin1");
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
/** scrypt cost — 16 MiB memory, interactive-grade; bump only with a new magic. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_PARAMS);
}

export function isEncryptedBackup(data: Buffer): boolean {
  return data.length > MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, ciphertext, cipher.getAuthTag()]);
}

/** Throws on wrong passphrase, truncation, or any tampering (GCM auth). */
export function decryptBackup(data: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBackup(data)) throw new Error("not an encrypted backup (bad magic)");
  const minLength = MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
  if (data.length < minLength) throw new Error("encrypted backup is truncated");
  let off = MAGIC.length;
  const salt = data.subarray(off, (off += SALT_LENGTH));
  const iv = data.subarray(off, (off += IV_LENGTH));
  const ciphertext = data.subarray(off, data.length - TAG_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("decryption failed — wrong passphrase or corrupted file");
  }
}
