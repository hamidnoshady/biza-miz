"use strict";

/**
 * Desktop multi-business profile registry (issue #1571 / ESH-222).
 *
 * ## What a "profile" is here, and what it is deliberately not
 *
 * One Windows installation may hold several *independent businesses*, and only
 * one of them may have a running local backend at a time. This module owns the
 * index of those businesses — not their data, and not their credentials.
 *
 * The key architectural decision is that **a profile is its own data root**,
 * not a second tenant in one local database. Each profile directory receives
 * the canonical `Configuration/ Data/ Backup/ Logs/` layout unchanged
 * (`app-paths.js`'s `computePaths`), so the profile gets:
 *
 *   - its own embedded PostgreSQL cluster (`Data/pgdata`) — a physically
 *     separate database, which is why no tenant id is ever rewritten and the
 *     "NOT a multi-tenant local DB" rule in the issue holds by construction;
 *   - its own generated secrets (`pgPassword`, `jwtSecret`, `masterKey`,
 *     `instanceId`), its own port pair, its own gateway certificates;
 *   - its own pairing/device identity, sync outbox/inbox, printers, caches,
 *     backups and logs, because all of those live in that directory or in that
 *     database.
 *
 * Installation-wide concerns stay at the install root and are *not* per
 * profile: the single-instance lock, the storage-location marker, the
 * folder-layout migration and the update engine. An app update is a property
 * of the installation, not of one business.
 *
 * ## The registry is an index of non-secret metadata only
 *
 * Passwords, PINs, tokens, session cookies, certificates and keys never belong
 * here — they live inside the profile's own config (safeStorage-encrypted) or
 * its database. That rule is enforced structurally rather than by comment:
 * `validateProfile` refuses any record carrying a credential-shaped key, and
 * `writeRegistry` refuses to persist a record it would not read back. A caller
 * cannot accidentally turn this file into a plaintext credential store.
 *
 * ## Failure posture
 *
 * The registry is read on every launch, and losing it would strand a business's
 * data behind a profile nobody can select. So an unreadable or malformed
 * registry is *reported*, never silently replaced — the same posture
 * `backend-manager.js` takes with an unreadable `config.json`. Reads are
 * atomic-write + rename, so a crash mid-write leaves the previous file intact.
 *
 * Pure decision logic with an injectable `fs`, so the migration/rollback paths
 * are unit-testable without a real multi-gigabyte cluster — see
 * src/lib/desktop-profile-registry.test.ts.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { computePaths, moveEntry } = require("./app-paths");

const REGISTRY_FILENAME = "business-profiles.json";
const REGISTRY_FORMAT = "bizamiz-desktop-business-profiles";
const REGISTRY_SCHEMA_VERSION = 1;
/** Profile data directories live here, one UUID-named child per business. */
const PROFILES_DIRNAME = "businesses";
/** A desktop is a till, not a multi-tenant cloud: this is a sanity ceiling, not a product limit. */
const MAX_PROFILES = 20;
const MAX_LABEL_LENGTH = 120;
const MAX_SUBDOMAIN_LENGTH = 63;

/** Lowercase UUID v1–v8, the only shape a profile directory name may take. */
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Deployment profiles a saved business can be in (src/lib/deployment-mode.ts). */
const BUSINESS_MODES = Object.freeze(["cloud", "hybrid", "local"]);

/**
 * Keys a profile record may never carry. This is the structural half of "never
 * store plaintext credentials in the registry": the record schema below is a
 * closed set of fields, and this list additionally catches a caller that tries
 * to smuggle a secret in under an innocuous field name.
 */
const FORBIDDEN_KEYS = Object.freeze([
  "password",
  "passwords",
  "pin",
  "pins",
  "secret",
  "secrets",
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "certificate",
  "certificates",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "jwtsecret",
  "pgpassword",
  "masterkey",
  "credential",
  "credentials",
]);

const PROFILE_FIELDS = Object.freeze([
  "id",
  "displayName",
  "businessName",
  "businessId",
  "businessSubdomain",
  "cloudOrigin",
  "mode",
  "source",
  "createdAt",
  "lastUsedAt",
]);

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function isProfileId(value) {
  return typeof value === "string" && PROFILE_ID_RE.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Where the registry file lives — the install root, beside the folders it indexes. */
function registryPath(installRoot) {
  return path.join(path.resolve(installRoot), REGISTRY_FILENAME);
}

/** The directory containing every profile's own data root. */
function profilesDir(installRoot) {
  return path.join(path.resolve(installRoot), PROFILES_DIRNAME);
}

/**
 * One profile's data root. Throws on anything that is not a UUID, so a crafted
 * profile id can never become a path traversal (`../../Windows`): the caller
 * gets an error, not a directory outside the install root.
 */
function profileDataDir(installRoot, profileId) {
  if (!isProfileId(profileId)) throw new Error(`Invalid desktop profile id: ${String(profileId)}`);
  return path.join(profilesDir(installRoot), profileId);
}

function emptyRegistry() {
  return {
    format: REGISTRY_FORMAT,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    lastUsedProfileId: null,
    profiles: [],
  };
}

/** Trim and bound a display label. Persian text is stored as typed, never transliterated. */
function normalizeLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * A cloud origin must be a bare https origin: no path, no query, no fragment,
 * no credentials. CloudPane pins navigation to exactly this origin, so a value
 * with a path here would silently narrow the allowed host later.
 */
function normalizeCloudOrigin(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
  return url.origin;
}

function normalizeSubdomain(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(candidate) || candidate.length > MAX_SUBDOMAIN_LENGTH) return undefined;
  return candidate;
}

/**
 * The closed record schema. Returns `null` for anything that is not a valid
 * record, and throws nothing — callers treat `null` as "refuse to use this
 * registry", never as "drop the record and carry on", because dropping one
 * record means one business's data becomes unreachable.
 */
function validateProfile(raw) {
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) return null;
    if (!PROFILE_FIELDS.includes(key)) return null;
  }
  if (!isProfileId(raw.id)) return null;

  const displayName = normalizeLabel(raw.displayName);
  if (!displayName) return null;

  if (raw.businessId !== null && raw.businessId !== undefined && !isProfileId(raw.businessId)) return null;
  const businessName = raw.businessName === null || raw.businessName === undefined
    ? null
    : normalizeLabel(raw.businessName) || null;

  const businessSubdomain = normalizeSubdomain(raw.businessSubdomain);
  if (businessSubdomain === undefined) return null;

  const cloudOrigin = normalizeCloudOrigin(raw.cloudOrigin);
  if (cloudOrigin === undefined) return null;

  const mode = raw.mode === null || raw.mode === undefined ? "cloud" : raw.mode;
  if (!BUSINESS_MODES.includes(mode)) return null;

  const source = raw.source ?? "added";
  if (!["legacy", "added"].includes(source)) return null;

  const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : null;
  if (!createdAt) return null;
  const lastUsedAt = raw.lastUsedAt === null || raw.lastUsedAt === undefined ? null : raw.lastUsedAt;
  if (lastUsedAt !== null && typeof lastUsedAt !== "string") return null;

  return {
    id: raw.id,
    displayName,
    businessName,
    businessId: raw.businessId ?? null,
    businessSubdomain,
    cloudOrigin,
    mode,
    source,
    createdAt,
    lastUsedAt,
  };
}

/**
 * A stored registry. Pointers naming a profile that no longer exists are reset
 * to `null` (self-healing, since nothing is lost); a malformed profile record
 * invalidates the whole file (fail closed, because dropping it would lose a
 * business).
 */
function validateRegistry(raw) {
  if (!isRecord(raw)) return null;
  if (raw.format !== REGISTRY_FORMAT) return null;
  if (raw.schemaVersion !== REGISTRY_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.profiles)) return null;
  if (raw.profiles.length > MAX_PROFILES) return null;

  const profiles = [];
  const seen = new Set();
  for (const candidate of raw.profiles) {
    const profile = validateProfile(candidate);
    if (!profile) return null;
    if (seen.has(profile.id)) return null;
    seen.add(profile.id);
    profiles.push(profile);
  }

  const pointer = (value) => (isProfileId(value) && seen.has(value) ? value : null);
  return {
    format: REGISTRY_FORMAT,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    lastUsedProfileId: pointer(raw.lastUsedProfileId),
    profiles,
  };
}

/**
 * Read the registry. `state` is one of:
 *   - `missing`    — no file yet (a fresh install, or one still to migrate)
 *   - `ok`         — parsed and valid
 *   - `unreadable` — exists but could not be read/parsed  → caller must not overwrite
 *   - `invalid`    — parsed, but not a registry this build understands → same
 */
function readRegistry(installRoot, fsImpl = fs) {
  const file = registryPath(installRoot);
  let text;
  try {
    if (!fsImpl.existsSync(file)) return { state: "missing", registry: emptyRegistry(), path: file };
    text = fsImpl.readFileSync(file, "utf8");
  } catch {
    return { state: "unreadable", registry: null, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "unreadable", registry: null, path: file };
  }
  const registry = validateRegistry(parsed);
  if (!registry) return { state: "invalid", registry: null, path: file };
  return { state: "ok", registry, path: file };
}

/**
 * Atomic write (temp file in the same directory, then rename) so an interrupted
 * write leaves the last good registry in place. The file is owner-readable only,
 * like `config.json` and `server.pid`.
 */
function writeRegistry(installRoot, registry, fsImpl = fs) {
  const validated = validateRegistry(registry);
  if (!validated) throw new Error("Refusing to write an invalid desktop business profile registry.");
  const file = registryPath(installRoot);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fsImpl.renameSync(temporary, file);
  } finally {
    try {
      fsImpl.rmSync(temporary, { force: true });
    } catch {}
  }
  return validated;
}

/**
 * A new profile record. `businessId`, `businessSubdomain` and `cloudOrigin` stay
 * `null` for a business added from the picker until enrollment/pairing proves
 * them — the profile is created so the existing setup wizard has a data root to
 * run in, and the identity columns are filled in by that flow.
 */
function createProfile(input = {}, now = new Date()) {
  const id = input.id ?? crypto.randomUUID();
  if (!isProfileId(id)) throw new Error(`Invalid desktop profile id: ${String(input.id)}`);
  const businessName = normalizeLabel(input.businessName) || null;
  const displayName = normalizeLabel(input.displayName) || businessName;
  if (!displayName) throw new Error("A desktop business profile needs a display name.");

  const cloudOrigin = normalizeCloudOrigin(input.cloudOrigin);
  if (cloudOrigin === undefined) throw new Error("A desktop business profile's cloud origin must be an https origin.");
  const businessSubdomain = normalizeSubdomain(input.businessSubdomain);
  if (businessSubdomain === undefined) throw new Error("A desktop business profile's subdomain is not a valid label.");

  const profile = validateProfile({
    id,
    displayName,
    businessName,
    businessId: input.businessId ?? null,
    businessSubdomain,
    cloudOrigin,
    mode: input.mode ?? "cloud",
    source: input.source ?? "added",
    createdAt: nowIso(now),
    lastUsedAt: null,
  });
  if (!profile) throw new Error("A desktop business profile record is not valid.");
  return profile;
}

/**
 * Add a profile. Refuses a duplicate of the *same business* — but only when both
 * sides carry a proven identity to compare (`businessId` or `cloudOrigin`); two
 * freshly added profiles that have not enrolled yet must not collide.
 */
function addProfile(registry, input, now = new Date()) {
  if (registry.profiles.length >= MAX_PROFILES) return { ok: false, error: "profile_limit" };
  const profile = createProfile(input, now);
  const duplicate = registry.profiles.find((existing) =>
    (profile.businessId && existing.businessId === profile.businessId) ||
    (profile.cloudOrigin && existing.cloudOrigin === profile.cloudOrigin &&
      (existing.businessSubdomain ?? null) === (profile.businessSubdomain ?? null)),
  );
  if (duplicate) return { ok: false, error: "duplicate_business", profile: duplicate };
  return {
    ok: true,
    profile,
    registry: { ...registry, profiles: [...registry.profiles, profile] },
  };
}

/**
 * Remove a profile from the *registry only*. Deleting its directory — which holds
 * a business's local sales and unsynced events — is a separate, explicitly
 * confirmed action in `profile-manager.js`; nothing here ever touches the disk.
 */
function removeProfile(registry, profileId) {
  const profile = registry.profiles.find((entry) => entry.id === profileId);
  if (!profile) return { ok: false, error: "profile_not_found" };
  return {
    ok: true,
    removed: profile,
    registry: {
      ...registry,
      profiles: registry.profiles.filter((entry) => entry.id !== profileId),
      lastUsedProfileId: registry.lastUsedProfileId === profileId ? null : registry.lastUsedProfileId,
    },
  };
}

/** Mark a profile as the last one used, which is what the picker highlights. */
function selectProfile(registry, profileId, now = new Date()) {
  const index = registry.profiles.findIndex((profile) => profile.id === profileId);
  if (index === -1) return { ok: false, error: "profile_not_found" };
  const stamp = nowIso(now);
  const profiles = registry.profiles.slice();
  profiles[index] = { ...profiles[index], lastUsedAt: stamp };
  return {
    ok: true,
    profile: profiles[index],
    registry: { ...registry, profiles, lastUsedProfileId: profileId },
  };
}

/**
 * Which canonical folders of an existing single-business install would be moved
 * into a profile. Runs *after* `app-paths.js`'s `migrateLegacyLayout`, so the
 * names here are the canonical ones, not the pre-Section-8 flat names.
 */
function planLegacyImport(installRoot, registry, fsImpl = fs) {
  if (registry.profiles.length > 0) return { needed: false, reason: "registry_has_profiles" };
  const paths = computePaths(installRoot);
  const entries = [
    { key: "configuration", name: "Configuration", source: paths.configDir },
    { key: "data", name: "Data", source: paths.dataDir },
    { key: "backup", name: "Backup", source: paths.backupDir },
    { key: "logs", name: "Logs", source: paths.logsDir },
  ].filter((entry) => {
    try {
      return fsImpl.existsSync(entry.source);
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return { needed: false, reason: "no_legacy_data" };
  return {
    needed: true,
    entries,
    /** Evidence the move carries a real database, for the caller's log line. */
    hasDatabase: fsImpl.existsSync(paths.pgDataDir),
  };
}

function moveBackSafely(entry, targetRoot, fsImpl) {
  try {
    moveEntry(path.join(targetRoot, entry.name), entry.source, fsImpl);
    return null;
  } catch (error) {
    return { key: entry.key, error: error?.message || String(error) };
  }
}

/**
 * Move a legacy single-business install into its first saved profile.
 *
 * Reversibility is the whole point: every move is recorded, and a failure at any
 * step moves the already-moved folders *back* before reporting, so a failed
 * migration leaves the installation exactly as it was — the "existing single-
 * business desktop upgrades without re-onboarding or losing unsynced sales"
 * acceptance gate. The registry is written last, so an interruption before that
 * write leaves the legacy layout authoritative and the migration is simply
 * retried on the next launch.
 *
 * The multi-gigabyte cluster is *moved*, never copied — a same-volume rename is
 * what keeps an upgrade fast enough to be safe.
 */
function importLegacyInstall(options) {
  const { installRoot, registry, fsImpl = fs, now = new Date(), displayName } = options;
  const plan = planLegacyImport(installRoot, registry, fsImpl);
  if (!plan.needed) return { ok: true, imported: false, reason: plan.reason };

  const profile = createProfile(
    {
      displayName: normalizeLabel(displayName) || "کسب‌وکار این نصب",
      businessName: normalizeLabel(displayName) || null,
      source: "legacy",
    },
    now,
  );
  const targetRoot = profileDataDir(installRoot, profile.id);

  const moved = [];
  try {
    for (const entry of plan.entries) {
      fsImpl.mkdirSync(targetRoot, { recursive: true });
      moveEntry(entry.source, path.join(targetRoot, entry.name), fsImpl);
      moved.push(entry);
    }
    const added = addProfile(registry, { ...profile, id: profile.id }, now);
    if (!added.ok) throw new Error(`profile_registry_refused:${added.error}`);
    const registryNext = writeRegistry(installRoot, added.registry, fsImpl);
    return {
      ok: true,
      imported: true,
      profile: added.profile,
      registry: registryNext,
      targetRoot,
      moved: moved.map((entry) => entry.name),
    };
  } catch (error) {
    const rollbackFailures = moved.map((entry) => moveBackSafely(entry, targetRoot, fsImpl)).filter(Boolean);
    if (rollbackFailures.length === 0) {
      try {
        fsImpl.rmSync(targetRoot, { recursive: true, force: true });
      } catch {}
    }
    return {
      ok: false,
      imported: false,
      reason: "move_failed",
      error: error?.message || String(error),
      rolledBack: rollbackFailures.length === 0,
      rollbackFailures,
    };
  }
}

/**
 * Delete one profile's local data root. Callers must have confirmed with the
 * user first: this is the only function that removes a business's local sales
 * and unsynced outbox, and it never touches the cloud business.
 */
function deleteProfileData(installRoot, profileId, fsImpl = fs) {
  const directory = profileDataDir(installRoot, profileId);
  if (!fsImpl.existsSync(directory)) return { ok: true, deleted: false, directory };
  fsImpl.rmSync(directory, { recursive: true, force: true });
  return { ok: true, deleted: true, directory };
}

/**
 * Which profiles currently hold data on disk — the fact a removal confirmation
 * needs, and the only cheap way to tell a fully enrolled business from one that
 * was added and never set up.
 */
function profileHasData(installRoot, profileId, fsImpl = fs) {
  const paths = computePaths(profileDataDir(installRoot, profileId));
  try {
    return fsImpl.existsSync(paths.pgDataDir) || fsImpl.existsSync(paths.configPath);
  } catch {
    return false;
  }
}

module.exports = {
  REGISTRY_FORMAT,
  REGISTRY_SCHEMA_VERSION,
  MAX_PROFILES,
  isProfileId,
  registryPath,
  profileDataDir,
  emptyRegistry,
  validateProfile,
  validateRegistry,
  readRegistry,
  writeRegistry,
  createProfile,
  addProfile,
  removeProfile,
  selectProfile,
  planLegacyImport,
  importLegacyInstall,
  deleteProfileData,
  profileHasData,
};
