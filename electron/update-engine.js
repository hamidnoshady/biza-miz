// One Desktop Update Engine for online, manual and offline Windows updates.
// It never replaces an executable until size + SHA-256 + Authenticode and a
// verified PostgreSQL backup have all succeeded.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { computePaths } = require("./app-paths");
const { launchStagedInstaller, pruneStagedInstallers, stageInstaller } = require("./installer-staging");
const {
  AUTO_INSTALL_GRACE_MS,
  MAX_LOCAL_POSTPONE_MS,
  decideAutoInstall,
  evaluateInstallSafety,
  parsePolicyDocument,
} = require("./update-policy");

const STATES = new Set([
  "checking", "no_update", "update_available", "downloading", "paused", "verifying",
  "ready_to_install", "backup_in_progress", "installing", "restarting",
  "verifying_health", "success", "failed", "recovery_required",
]);
const CHANNELS = new Set(["stable", "beta", "internal"]);
const RELEASE_APP_ID = "bizamiz-desktop";
const MANIFEST_ALGORITHMS = new Set(["ed25519", "rsa-sha256"]);
const RELEASE_PLATFORMS = new Set(["win32"]);
const RELEASE_ARCHITECTURES = new Set(["x64", "arm64", "ia32"]);
/** Clock-tolerant freshness: an hour of skew must not block a valid release. */
const MANIFEST_EXPIRY_GRACE_MS = 24 * 3_600_000;
const PRE_UPDATE_BACKUP_RETENTION = 5;
// Issue #1000 - progress used to be persisted (and emitted over IPC) once per
// received chunk. Four updates a second is enough for a progress bar and keeps
// the state file off the download's critical path.
const PROGRESS_EMIT_INTERVAL_MS = 250;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
];

function parseSemVer(value) {
  const match = String(value || "").trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : [],
  };
}

function compareSemVer(left, right) {
  const a = parseSemVer(left); const b = parseSemVer(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index]; const bv = b.prerelease[index];
    if (av === undefined) return -1; if (bv === undefined) return 1; if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function canonicalManifestPayloadV1(manifest) {
  return JSON.stringify({
    version: manifest.version,
    buildCommit: manifest.buildCommit,
    buildId: manifest.buildId,
    channel: manifest.channel,
    minimumSupportedVersion: manifest.minimumSupportedVersion,
    mandatory: manifest.mandatory,
    installer: {
      url: manifest.installer.url,
      sha256: manifest.installer.sha256,
      size: manifest.installer.size,
      signatureRequired: manifest.installer.signatureRequired,
      expectedPublisher: manifest.installer.expectedPublisher,
      // Optional so a manifest signed before thumbprint pinning existed still
      // verifies byte-for-byte; new releases always carry it (safeManifest).
      ...(manifest.installer.expectedPublisherThumbprint
        ? { expectedPublisherThumbprint: manifest.installer.expectedPublisherThumbprint }
        : {}),
    },
    database: {
      migrationVersion: manifest.database.migrationVersion,
      minimumSchemaVersion: manifest.database.minimumSchemaVersion,
      maximumSchemaVersion: manifest.database.maximumSchemaVersion,
      backupRequired: manifest.database.backupRequired,
    },
    releaseNotes: manifest.releaseNotes,
  });
}

/**
 * Schema 2 binds everything that can select or execute installer bytes, plus
 * the app identity, platform/architecture, release sequence, freshness and the
 * id of the key that signed it. Authenticode is optional here, never the
 * manifest signature.
 */
function canonicalManifestPayloadV2(manifest) {
  return JSON.stringify({
    schemaVersion: 2,
    appId: manifest.appId,
    version: manifest.version,
    releaseSequence: manifest.releaseSequence,
    buildCommit: manifest.buildCommit,
    buildId: manifest.buildId,
    channel: manifest.channel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    releasedAt: manifest.releasedAt,
    expiresAt: manifest.expiresAt ?? null,
    minimumSupportedVersion: manifest.minimumSupportedVersion,
    mandatory: manifest.mandatory,
    installer: {
      url: manifest.installer.url,
      sha256: manifest.installer.sha256,
      size: manifest.installer.size,
      signatureRequired: manifest.installer.signatureRequired === true,
    },
    database: {
      migrationVersion: manifest.database.migrationVersion,
      minimumSchemaVersion: manifest.database.minimumSchemaVersion,
      maximumSchemaVersion: manifest.database.maximumSchemaVersion,
      backupRequired: manifest.database.backupRequired,
    },
    releaseNotes: manifest.releaseNotes,
    recovery: {
      knownGoodVersion: manifest.recovery?.knownGoodVersion ?? null,
      notes: manifest.recovery?.notes ?? null,
    },
    signatureAlgorithm: manifest.signatureAlgorithm,
    signingKeyId: manifest.signingKeyId,
  });
}

function canonicalManifestPayload(manifest) {
  return (manifest.schemaVersion ?? 1) >= 2
    ? canonicalManifestPayloadV2(manifest)
    : canonicalManifestPayloadV1(manifest);
}

function safeManifest(value) {
  if (!value || typeof value !== "object") throw updateError("manifest_invalid");
  const manifest = value;
  const schemaVersion = manifest.schemaVersion === undefined ? 1 : manifest.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw updateError("manifest_schema_unsupported");
  if (!parseSemVer(manifest.version)) throw updateError("manifest_version_invalid");
  if (typeof manifest.buildCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(manifest.buildCommit)) throw updateError("manifest_commit_invalid");
  if (typeof manifest.buildId !== "string" || !manifest.buildId.trim() || manifest.buildId.length > 200) throw updateError("manifest_build_invalid");
  if (typeof manifest.releasedAt !== "string" || !Number.isFinite(Date.parse(manifest.releasedAt))) throw updateError("manifest_release_time_invalid");
  if (typeof manifest.manifestSignature !== "string" || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(manifest.manifestSignature)) throw updateError("manifest_signature_invalid");
  if (!CHANNELS.has(manifest.channel)) throw updateError("manifest_channel_invalid");
  if (!manifest.installer || typeof manifest.installer !== "object") throw updateError("manifest_installer_invalid");
  const url = new URL(String(manifest.installer.url || ""));
  if (url.protocol !== "https:") throw updateError("manifest_installer_url_invalid");
  if (!/^[0-9a-f]{64}$/.test(String(manifest.installer.sha256 || ""))) throw updateError("manifest_installer_hash_invalid");
  if (!Number.isSafeInteger(manifest.installer.size) || manifest.installer.size < 1) throw updateError("manifest_installer_size_invalid");
  if (!manifest.database || manifest.database.backupRequired !== true) throw updateError("manifest_backup_required");
  if (!Array.isArray(manifest.releaseNotes) || !manifest.releaseNotes.every((note) => typeof note === "string")) throw updateError("manifest_release_notes_invalid");

  if (schemaVersion === 1) {
    if (manifest.installer.signatureRequired !== true) throw updateError("manifest_signature_required");
    if (typeof manifest.installer.expectedPublisher !== "string" || !manifest.installer.expectedPublisher.trim()) throw updateError("expected_publisher_missing");
    // Issue #1000 - the certificate thumbprint is part of the signed manifest, so
    // a release can only be installed by that exact signing certificate. A
    // missing pin is a refusal, not a fall back to the subject/CN check.
    const thumbprint = typeof manifest.installer.expectedPublisherThumbprint === "string"
      ? manifest.installer.expectedPublisherThumbprint.trim()
      : "";
    if (!thumbprint) throw updateError("expected_publisher_thumbprint_missing");
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw updateError("expected_publisher_thumbprint_invalid");
    return JSON.parse(JSON.stringify({ ...manifest, installer: { ...manifest.installer, url: url.toString() } }));
  }

  if (manifest.appId !== RELEASE_APP_ID) throw updateError("manifest_app_identity_invalid");
  if (!MANIFEST_ALGORITHMS.has(manifest.signatureAlgorithm)) throw updateError("manifest_algorithm_invalid");
  const signingKeyId = typeof manifest.signingKeyId === "string" ? manifest.signingKeyId.trim() : "";
  if (signingKeyId.length < 8 || signingKeyId.length > 200 || !/^[A-Za-z0-9:+._-]+$/.test(signingKeyId)) {
    throw updateError("manifest_signing_key_invalid");
  }
  if (!Number.isSafeInteger(manifest.releaseSequence) || manifest.releaseSequence < 1) throw updateError("manifest_release_sequence_invalid");
  if (!RELEASE_PLATFORMS.has(manifest.platform)) throw updateError("manifest_platform_invalid");
  if (!RELEASE_ARCHITECTURES.has(manifest.architecture)) throw updateError("manifest_architecture_invalid");
  const minimum = manifest.minimumSupportedVersion;
  if (minimum !== null && minimum !== undefined && (typeof minimum !== "string" || !parseSemVer(minimum))) throw updateError("manifest_minimum_version_invalid");
  let expiresAt = null;
  if (manifest.expiresAt !== null && manifest.expiresAt !== undefined && manifest.expiresAt !== "") {
    if (typeof manifest.expiresAt !== "string" || !Number.isFinite(Date.parse(manifest.expiresAt))) throw updateError("manifest_expiry_invalid");
    if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.releasedAt)) throw updateError("manifest_expiry_invalid");
    expiresAt = new Date(manifest.expiresAt).toISOString();
  }
  if (typeof manifest.installer.signatureRequired !== "boolean") throw updateError("manifest_signature_required_invalid");
  let expectedPublisher = null;
  let expectedPublisherThumbprint = null;
  if (manifest.installer.signatureRequired) {
    if (typeof manifest.installer.expectedPublisher !== "string" || !manifest.installer.expectedPublisher.trim()) throw updateError("expected_publisher_missing");
    const thumbprint = typeof manifest.installer.expectedPublisherThumbprint === "string"
      ? manifest.installer.expectedPublisherThumbprint.trim()
      : "";
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw updateError("expected_publisher_thumbprint_invalid");
    expectedPublisher = manifest.installer.expectedPublisher.trim();
    expectedPublisherThumbprint = thumbprint.toUpperCase();
  }
  return {
    ...manifest,
    schemaVersion: 2,
    appId: RELEASE_APP_ID,
    signingKeyId,
    releaseSequence: manifest.releaseSequence,
    platform: manifest.platform,
    architecture: manifest.architecture,
    expiresAt,
    minimumSupportedVersion: typeof minimum === "string" ? minimum : null,
    mandatory: manifest.mandatory === true,
    installer: {
      ...manifest.installer,
      url: url.toString(),
      signatureRequired: manifest.installer.signatureRequired,
      expectedPublisher,
      expectedPublisherThumbprint,
    },
  };
}

function updateError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr.trim()}`)));
  });
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Exact publisher pinning (issue #1000). The expected publisher is the exact
 * Authenticode certificate Subject or its exact common name - never a
 * substring, glob or prefix, so a publisher name no longer matches a
 * certificate such as "CN=<publisher> Test Signer". Case is ignored because
 * Windows renders the distinct-name order and casing itself.
 */
function publisherMatchesCertificate(certificate, expectedPublisher) {
  const expected = String(expectedPublisher || "").trim().toLowerCase();
  if (!expected || !certificate) return false;
  return [certificate.subject, certificate.simpleName]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .some((value) => value.length > 0 && value === expected);
}

/**
 * Windows SHA-1 thumbprints are hex and case-insensitive; a manifest pin and
 * the certificate it describes must be the same 20 bytes, not merely similar.
 */
function thumbprintMatchesCertificate(certificate, expectedThumbprint) {
  const normalize = (value) => (typeof value === "string" ? value.replace(/[\s:]/g, "").toUpperCase() : "");
  const expected = normalize(expectedThumbprint);
  const actual = normalize(certificate?.thumbprint);
  return /^[0-9A-F]{40}$/.test(expected) && actual === expected;
}

/** Both halves of the pin: exact Subject/common name and exact thumbprint. */
function certificateMatchesPin(certificate, expectedPublisher, expectedThumbprint) {
  return publisherMatchesCertificate(certificate, expectedPublisher) &&
    thumbprintMatchesCertificate(certificate, expectedThumbprint);
}

/** A keyring is data, never an inline key chosen by the server or manifest. */
function normalizeKeyring(value) {
  const empty = { schemaVersion: 1, keys: [] };
  if (!value) return empty;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return empty; }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.keys)) return empty;
  const keys = parsed.keys
    .filter((entry) => entry && typeof entry === "object" &&
      typeof entry.id === "string" && entry.id.trim().length >= 8 && entry.id.length <= 200 &&
      typeof entry.publicKeyPem === "string" && entry.publicKeyPem.includes("BEGIN PUBLIC KEY") &&
      MANIFEST_ALGORITHMS.has(entry.algorithm))
    .map((entry) => ({
      id: entry.id.trim(),
      algorithm: entry.algorithm,
      publicKeyPem: entry.publicKeyPem.replaceAll("\\n", "\n").trim(),
      notBefore: typeof entry.notBefore === "string" ? entry.notBefore : null,
      notAfter: typeof entry.notAfter === "string" ? entry.notAfter : null,
      revoked: entry.revoked === true,
    }));
  return { schemaVersion: 1, keys };
}

class DesktopUpdateEngine extends EventEmitter {
  constructor({ app, logger, expectedPublisher, allowedOrigins, manifestPublicKey, manifestKeyring, platform, architecture, commandRunner }) {
    super();
    this.app = app; this.logger = logger;
    this.commandRunner = commandRunner || run;
    const paths = computePaths(app.getPath("userData"));
    this.dir = path.join(paths.dataDir, "Updates");
    this.backupDir = path.join(paths.backupDir, "pre-update");
    this.statePath = path.join(paths.configDir, "update-state.json");
    this.targetPath = path.join(paths.configDir, "update-target.json");
    this.policyPath = path.join(paths.configDir, "update-policy.json");
    this.commandPath = path.join(paths.configDir, "update-command.json");
    // A packaged app trusts only keys shipped inside app.asar. Environment
    // overrides exist for the test harness and a controlled migration window,
    // never as a way for a server or an operator flag to replace the anchor.
    const packaged = app?.isPackaged === true;
    const allowEnvironmentTrust = !packaged || process.env.DESKTOP_ALLOW_RELEASE_KEY_OVERRIDE === "1";
    this.platform = String(platform || process.platform);
    this.architecture = String(architecture || process.arch);
    this.expectedPublisher = String(expectedPublisher || (allowEnvironmentTrust ? process.env.WINDOWS_EXPECTED_SIGNER : "") || "").trim();
    this.manifestPublicKey = String(manifestPublicKey || (allowEnvironmentTrust ? process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM : "") || "").replaceAll("\\n", "\n").trim();
    if (!this.manifestPublicKey) {
      try { this.manifestPublicKey = fs.readFileSync(path.join(__dirname, "desktop-release-public-key.pem"), "utf8").trim(); } catch { /* fail closed during verification */ }
    }
    const environmentKeyring = allowEnvironmentTrust ? process.env.DESKTOP_RELEASE_KEYS_JSON : null;
    if (manifestKeyring !== undefined) this.manifestKeyring = normalizeKeyring(manifestKeyring);
    else if (environmentKeyring) this.manifestKeyring = normalizeKeyring(environmentKeyring);
    else {
      try { this.manifestKeyring = normalizeKeyring(fs.readFileSync(path.join(__dirname, "desktop-release-keys.json"), "utf8")); }
      catch { this.manifestKeyring = normalizeKeyring(null); }
    }
    const configured = String(process.env.DESKTOP_UPDATE_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    this.allowedOrigins = new Set([...(allowedOrigins || DEFAULT_ALLOWED_ORIGINS), ...configured]);
    this.abortController = null;
    this.commandBusy = false;
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(this.dir, { recursive: true }); fs.mkdirSync(this.backupDir, { recursive: true });
    this.state = this.loadState();
  }

  defaultState() {
    return {
      schemaVersion: 1, state: "no_update", installedVersion: this.app.getVersion(), target: null,
      progress: null, installerPath: null, backupPath: null, errorCode: null,
      errorDetail: null, checkedAt: null, updatedAt: new Date().toISOString(),
      policy: { automaticChecks: true, backgroundDownload: false, automaticInstall: false, channel: "stable" },
      installOnNextRestart: false, previousVersion: null, stagedInstaller: null,
      // Central's resolved policy (see update-policy.js) and the unattended
      // install's visible status. Both are null on an install Central never
      // configured, which behaves exactly as before this layer existed.
      centralPolicy: null, autoInstall: null,
      // Per-channel anti-rollback counters. A release sequence only ever moves
      // forward for the channel it was signed for.
      releaseSequences: {},
      lastCommandSequence: 0, commandResults: [],
    };
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!STATES.has(parsed.state)) throw new Error("invalid state");
      return { ...this.defaultState(), ...parsed, installedVersion: this.app.getVersion() };
    } catch { return this.defaultState(); }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
  }

  publicState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  transition(state, patch = {}) {
    if (!STATES.has(state)) throw updateError("update_state_invalid");
    this.state = { ...this.state, ...patch, state, updatedAt: new Date().toISOString() };
    this.persist(); this.emit("state", this.publicState()); return this.publicState();
  }

  fail(error) {
    const code = error?.code || "update_failed";
    this.logger.warn("Desktop update failed", { code, detail: error?.message });
    return this.transition(code === "post_update_version_mismatch" ? "recovery_required" : "failed", {
      errorCode: code, errorDetail: String(error?.message || error).slice(0, 1000), progress: null,
    });
  }

  setPolicy(input) {
    const channel = CHANNELS.has(input?.channel) ? input.channel : this.state.policy.channel;
    this.state.policy = {
      automaticChecks: input?.automaticChecks !== false,
      backgroundDownload: input?.backgroundDownload === true,
      // Unattended executable installation remains forbidden. A user may only
      // choose now or next restart after readiness is visible.
      automaticInstall: false,
      channel,
    };
    this.enforceCentralPolicy();
    this.persist(); this.emit("state", this.publicState()); return this.publicState();
  }

  centralPolicyActive(now = new Date()) {
    const central = this.state.centralPolicy;
    return Boolean(central && Date.parse(central.expiresAt) > now.getTime());
  }

  /**
   * While an unexpired central policy governs, its check/download/channel
   * values win over local preferences. Unattended install is never copied into
   * the local policy: it is read from `centralPolicy` at decision time.
   */
  enforceCentralPolicy() {
    if (!this.centralPolicyActive()) return;
    const { policy } = this.state.centralPolicy;
    this.state.policy = {
      ...this.state.policy,
      automaticChecks: policy.automaticChecks,
      backgroundDownload: policy.backgroundDownload && !policy.hold,
      channel: policy.channel ?? this.state.policy.channel,
    };
  }

  /**
   * Reads the document the local backend wrote after an authenticated Central
   * exchange. A document is applied only if it validates and is not older than
   * the one already held: an older policy version is a rollback, and a copy
   * from the same version only refreshes its lifetime.
   */
  applyPersistedPolicy() {
    try {
      const metadata = fs.statSync(this.policyPath);
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > 16 * 1024) throw updateError("persisted_policy_invalid");
      const parsed = parsePolicyDocument(JSON.parse(fs.readFileSync(this.policyPath, "utf8")));
      if (!parsed.ok) throw updateError(parsed.error);
      const held = this.state.centralPolicy;
      if (held && parsed.document.policyVersion < held.policyVersion) return false;
      if (held && parsed.document.policyVersion === held.policyVersion && Date.parse(parsed.document.issuedAt) <= Date.parse(held.issuedAt)) return false;
      this.state.centralPolicy = parsed.document;
      this.enforceCentralPolicy();
      this.persist(); this.emit("state", this.publicState());
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") this.logger.warn("Central update policy ignored", { code: error?.code, detail: error?.message });
      return false;
    }
  }

  recordCommandResult(command, status, code = null) {
    const result = { id: command.id, sequence: command.sequence, status, occurredAt: new Date().toISOString(), code };
    const previous = Array.isArray(this.state.commandResults) ? this.state.commandResults : [];
    this.state.commandResults = [...previous.filter((item) => item.id !== command.id), result].slice(-20);
    this.persist(); this.emit("state", this.publicState());
  }

  /** Execute only narrow verbs against this existing engine; commands never carry artifacts or URLs. */
  async applyPersistedCommand(now = new Date()) {
    if (this.commandBusy) return false;
    this.commandBusy = true;
    let command;
    try {
      const metadata = fs.statSync(this.commandPath);
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > 8 * 1024) throw updateError("persisted_command_invalid");
      command = JSON.parse(fs.readFileSync(this.commandPath, "utf8"));
      if (command?.schemaVersion !== 1 || typeof command.id !== "string" ||
          !Number.isSafeInteger(command.sequence) || command.sequence < 1 ||
          !["recheck", "download_now"].includes(command.command) ||
          !Number.isFinite(Date.parse(command.issuedAt)) || !(Date.parse(command.expiresAt) > now.getTime())) {
        throw updateError("persisted_command_invalid");
      }
      const central = this.state.centralPolicy;
      if (!central || central.businessId !== command.businessId || central.deviceId !== command.deviceId) {
        throw updateError("command_identity_mismatch");
      }
      if (command.sequence <= (this.state.lastCommandSequence ?? 0)) { this.commandBusy = false; return false; }
      this.state.lastCommandSequence = command.sequence;
      this.recordCommandResult(command, "acknowledged");
      fs.rmSync(this.commandPath, { force: true });
      if (command.command === "recheck") {
        this.checkPersistedTarget();
        this.recordCommandResult(command, "executed");
        this.commandBusy = false;
        return true;
      }
      this.checkPersistedTarget();
      if (this.state.state === "paused" || this.state.state === "update_available") await this.download();
      if (this.state.state !== "ready_to_install") throw updateError("command_download_not_ready");
      this.recordCommandResult(command, "verified");
      this.commandBusy = false;
      return true;
    } catch (error) {
      this.commandBusy = false;
      if (error?.code === "ENOENT") return false;
      fs.rmSync(this.commandPath, { force: true });
      this.logger.warn("Central update command ignored or failed", { code: error?.code, detail: error?.message });
      if (command?.id && Number.isSafeInteger(command.sequence)) this.recordCommandResult(command, "failed", error?.code || "command_failed");
      return false;
    }
  }

  setAutoInstall(patch) {
    const previous = this.state.autoInstall ?? {};
    const next = { postponedUntil: previous.postponedUntil ?? null, ...patch, evaluatedAt: new Date().toISOString() };
    const changed = ["allowed", "reason", "scheduledFor", "postponedUntil"].some((key) => previous[key] !== next[key])
      || JSON.stringify(previous.blockers ?? []) !== JSON.stringify(next.blockers ?? []);
    this.state.autoInstall = next;
    if (changed) { this.persist(); this.emit("state", this.publicState()); }
  }

  /** The user may defer an announced unattended install, but only briefly. */
  postponeAutoInstall(hours) {
    if (this.state.state !== "ready_to_install") throw updateError("update_not_ready");
    const requested = Math.max(0, Number(hours) || 0) * 3_600_000;
    const until = new Date(Date.now() + Math.min(requested, MAX_LOCAL_POSTPONE_MS)).toISOString();
    this.setAutoInstall({ ...(this.state.autoInstall ?? {}), scheduledFor: null, postponedUntil: until, reason: "postponed_locally", allowed: false });
    return this.publicState();
  }

  /**
   * One evaluation of the unattended install. Returns what the caller should do;
   * it never installs by itself. Policy permission, safety facts and a visible
   * grace period must ALL agree, and any doubt is a "not now".
   */
  async autoInstallTick({ now = new Date(), readSafety, readSystem } = {}) {
    if (this.state.state !== "ready_to_install") {
      if (this.state.autoInstall) { this.state.autoInstall = null; this.persist(); this.emit("state", this.publicState()); }
      return { action: "none" };
    }
    const central = this.state.centralPolicy;
    const decision = decideAutoInstall({
      policy: central?.policy ?? null, expiresAt: central?.expiresAt, now,
      postponedUntil: this.state.autoInstall?.postponedUntil ?? null,
    });
    if (!decision.allowed) {
      this.setAutoInstall({ allowed: false, reason: decision.reason, scheduledFor: null, blockers: [] });
      return { action: "blocked", reason: decision.reason };
    }
    let facts = null;
    try { facts = { ...(readSystem ? await readSystem() : {}), ...(await readSafety()) }; } catch (error) {
      this.logger.warn("Install safety facts unavailable", { detail: error?.message });
    }
    const safety = evaluateInstallSafety(facts, central.policy);
    if (!safety.safe) {
      this.setAutoInstall({ allowed: false, reason: "unsafe", scheduledFor: null, blockers: safety.blockers });
      return { action: "blocked", reason: "unsafe", blockers: safety.blockers };
    }
    let scheduledFor = this.state.autoInstall?.allowed ? this.state.autoInstall.scheduledFor : null;
    // A schedule left over from before a restart or a long suspend was announced
    // for a moment nobody saw; announce it again instead of installing at once.
    if (scheduledFor && now.getTime() - Date.parse(scheduledFor) > 10 * 60_000) scheduledFor = null;
    if (!scheduledFor) {
      this.setAutoInstall({ allowed: true, reason: decision.reason, scheduledFor: new Date(now.getTime() + AUTO_INSTALL_GRACE_MS).toISOString(), blockers: [] });
      return { action: "scheduled" };
    }
    if (Date.parse(scheduledFor) > now.getTime()) return { action: "waiting" };
    return { action: "install" };
  }

  verifyManifestSignature(manifest) {
    const schemaVersion = manifest.schemaVersion ?? 1;
    const payload = Buffer.from(canonicalManifestPayload(manifest));
    const signature = Buffer.from(manifest.manifestSignature, "base64");
    if (schemaVersion >= 2) {
      const entry = this.manifestKeyring.keys.find((key) => key.id === manifest.signingKeyId);
      if (!entry) throw updateError("manifest_signing_key_unknown");
      if (entry.revoked) throw updateError("manifest_signing_key_revoked");
      if (entry.algorithm !== manifest.signatureAlgorithm) throw updateError("manifest_key_algorithm_mismatch");
      const now = Date.now();
      if (entry.notBefore && Date.parse(entry.notBefore) > now) throw updateError("manifest_signing_key_not_yet_valid");
      if (entry.notAfter && Date.parse(entry.notAfter) < now) throw updateError("manifest_signing_key_expired");
      try {
        const key = crypto.createPublicKey(entry.publicKeyPem);
        const valid = manifest.signatureAlgorithm === "ed25519"
          ? crypto.verify(null, payload, key, signature)
          : crypto.verify("sha256", payload, key, signature);
        if (!valid) throw updateError("manifest_signature_invalid");
      } catch (error) {
        if (error?.code === "manifest_signature_invalid") throw error;
        throw updateError("manifest_signature_invalid", error);
      }
      return;
    }
    if (!this.manifestPublicKey) throw updateError("manifest_public_key_missing");
    try {
      const valid = crypto.verify(
        "sha256",
        payload,
        crypto.createPublicKey(this.manifestPublicKey),
        signature,
      );
      if (!valid) throw updateError("manifest_signature_invalid");
    } catch (error) {
      if (error?.code === "manifest_signature_invalid") throw error;
      throw updateError("manifest_signature_invalid", error);
    }
  }

  checkPersistedTarget() {
    this.applyPersistedPolicy();
    if (!this.state.policy.automaticChecks) return this.publicState();
    if (["downloading", "paused", "verifying", "ready_to_install", "backup_in_progress", "installing", "restarting", "recovery_required"].includes(this.state.state)) {
      return this.publicState();
    }
    try {
      const metadata = fs.statSync(this.targetPath);
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > 64 * 1024) throw updateError("persisted_target_invalid");
      return this.check(JSON.parse(fs.readFileSync(this.targetPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return this.publicState();
      return this.fail(error?.code ? error : updateError("persisted_target_invalid", error));
    }
  }

  /**
   * Identity, platform and replay checks that are independent of the installed
   * version. They run only for a manifest that is allowed to replace bytes.
   */
  assertManifestApplicable(manifest, { now = new Date() } = {}) {
    if ((manifest.schemaVersion ?? 1) >= 2) {
      if (manifest.appId !== RELEASE_APP_ID) throw updateError("manifest_app_identity_invalid");
      if (manifest.platform !== this.platform) throw updateError("manifest_platform_mismatch");
      if (manifest.architecture !== this.architecture) throw updateError("manifest_architecture_mismatch");
      const applied = Number(this.state.releaseSequences?.[manifest.channel] ?? 0);
      if (manifest.releaseSequence <= applied) throw updateError("release_sequence_rollback");
      if (manifest.expiresAt) {
        const released = Date.parse(manifest.releasedAt);
        // A clock behind the release time is not evidence of expiry; offline
        // clients keep working and anti-rollback stays sequence-based.
        if (Number.isFinite(released) && now.getTime() >= released &&
            now.getTime() > Date.parse(manifest.expiresAt) + MANIFEST_EXPIRY_GRACE_MS) {
          throw updateError("manifest_expired");
        }
      }
    }
    if (manifest.minimumSupportedVersion && compareSemVer(this.app.getVersion(), manifest.minimumSupportedVersion) < 0) {
      throw updateError("installed_version_unsupported");
    }
  }

  check(manifestValue) {
    this.transition("checking", { checkedAt: new Date().toISOString(), errorCode: null, errorDetail: null });
    try {
      if (!manifestValue) return this.transition("no_update", { target: null, progress: null });
      const manifest = safeManifest(manifestValue);
      this.verifyManifestSignature(manifest);
      if (manifest.channel !== this.state.policy.channel) throw updateError("release_channel_mismatch");
      const comparison = compareSemVer(this.app.getVersion(), manifest.version);
      if (comparison === null) throw updateError("installed_version_invalid");
      if (comparison >= 0) return this.transition("no_update", { target: manifest, progress: null });
      this.assertManifestApplicable(manifest);
      const targetUrl = new URL(manifest.installer.url);
      if (!this.allowedOrigins.has(targetUrl.origin)) throw updateError("installer_origin_not_allowed");
      const next = this.transition("update_available", { target: manifest, progress: null, installerPath: null, backupPath: null });
      if (this.state.policy.backgroundDownload) void this.download().catch((error) => this.fail(error));
      return next;
    } catch (error) { return this.fail(error); }
  }

  async fetchAllowed(url, options = {}, redirects = 0) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !this.allowedOrigins.has(parsed.origin)) throw updateError("installer_origin_not_allowed");
    const response = await fetch(parsed, { ...options, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 5) throw updateError("download_redirect_limit");
      const location = response.headers.get("location"); if (!location) throw updateError("download_redirect_invalid");
      return this.fetchAllowed(new URL(location, parsed).toString(), options, redirects + 1);
    }
    return response;
  }

  async download() {
    const manifest = this.state.target;
    if (!manifest) throw updateError("update_target_missing");
    const finalPath = path.join(this.dir, `Bizamiz-${manifest.version}-Update.exe`);
    const partialPath = `${finalPath}.part`;
    const existing = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    if (existing > manifest.installer.size) fs.rmSync(partialPath, { force: true });
    this.abortController = new AbortController();
    this.transition("downloading", { progress: { received: existing, total: manifest.installer.size, percent: Math.floor(existing / manifest.installer.size * 100) } });
    try {
      const offset = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      const response = await this.fetchAllowed(manifest.installer.url, {
        signal: this.abortController.signal,
        headers: offset ? { Range: `bytes=${offset}-` } : {},
      });
      if (!response.ok || !response.body) throw updateError(`download_http_${response.status}`);
      const append = offset > 0 && response.status === 206;
      if (offset > 0 && !append) fs.rmSync(partialPath, { force: true });
      let received = append ? offset : 0;
      let lastProgressAt = 0;
      const stream = fs.createWriteStream(partialPath, { flags: append ? "a" : "w", mode: 0o600 });
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > manifest.installer.size) throw updateError("download_size_mismatch");
        if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
        const stamp = Date.now();
        if (stamp - lastProgressAt < PROGRESS_EMIT_INTERVAL_MS) continue;
        lastProgressAt = stamp;
        this.transition("downloading", { progress: { received, total: manifest.installer.size, percent: Math.floor(received / manifest.installer.size * 100) } });
      }
      await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
      if (received !== manifest.installer.size) throw updateError("download_size_mismatch");
      fs.renameSync(partialPath, finalPath);
      return await this.verifyInstaller(finalPath, manifest);
    } catch (error) {
      if (error?.name === "AbortError" && this.state.state === "paused") return this.publicState();
      throw error;
    } finally { this.abortController = null; }
  }

  pause() {
    if (this.state.state !== "downloading") return this.publicState();
    this.transition("paused"); this.abortController?.abort(); return this.publicState();
  }

  cancel() {
    this.abortController?.abort();
    if (this.state.installerPath) fs.rmSync(this.state.installerPath, { force: true });
    if (this.state.stagedInstaller?.path) fs.rmSync(this.state.stagedInstaller.path, { force: true });
    this.state.stagedInstaller = null;
    return this.transition("update_available", { progress: null, installerPath: null, backupPath: null, installOnNextRestart: false });
  }

  async verifyInstaller(installerPath, manifestValue) {
    this.transition("verifying", { progress: null });
    const manifest = await this.verifyInstallerBytes(installerPath, manifestValue);
    return this.transition("ready_to_install", { target: manifest, installerPath, errorCode: null, errorDetail: null });
  }

  /**
   * The download-time integrity checks, kept callable on their own so the
   * launch path can repeat exactly them immediately before execution. The
   * installer sits in a user-writable folder between download and install, so
   * verifying only at download time leaves a TOCTOU window (issue #1000).
   */
  async verifyInstallerBytes(installerPath, manifestValue) {
    const manifest = safeManifest(manifestValue);
    this.verifyManifestSignature(manifest);
    const stat = fs.statSync(installerPath);
    if (stat.size !== manifest.installer.size) throw updateError("installer_size_mismatch");
    const digest = await fileSha256(installerPath);
    if (digest !== manifest.installer.sha256) throw updateError("installer_sha256_mismatch");
    // Schema 2 makes Authenticode optional defense-in-depth. It is never a
    // substitute for the signed manifest and SHA-256 checked above, and a
    // manifest that asks for it must carry an exact publisher + thumbprint.
    if (manifest.installer.signatureRequired === true) {
      await this.verifyAuthenticode(installerPath, manifest.installer.expectedPublisher, manifest.installer.expectedPublisherThumbprint);
    }
    return manifest;
  }

  /**
   * Reads the signer identity from Windows and decides the publisher pin in
   * Node, so the comparison is exact and testable rather than a PowerShell
   * wildcard match. `status` must be Valid (a chain and timestamp Windows
   * accepted) before the identity is even considered.
   */
  async verifyAuthenticode(installerPath, manifestPublisher, manifestThumbprint) {
    if (process.platform !== "win32") throw updateError("authenticode_windows_required");
    const publisher = String(manifestPublisher || this.expectedPublisher || "").trim();
    if (!publisher) throw updateError("expected_publisher_missing");
    const thumbprint = String(manifestThumbprint || "").trim();
    if (!thumbprint) throw updateError("expected_publisher_thumbprint_missing");
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw updateError("expected_publisher_thumbprint_invalid");
    const script = [
      "$s=Get-AuthenticodeSignature -LiteralPath $args[0]",
      "$c=$s.SignerCertificate",
      "$subject=$null;$simpleName=$null;$thumbprint=$null",
      "if($c){$subject=[string]$c.Subject;$simpleName=[string]$c.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);$thumbprint=[string]$c.Thumbprint}",
      "[ordered]@{status=[string]$s.Status;subject=$subject;simpleName=$simpleName;thumbprint=$thumbprint} | ConvertTo-Json -Compress",
    ].join(";");
    let stdout = "";
    try {
      ({ stdout } = await this.commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, installerPath]));
    } catch (error) { throw updateError("authenticode_invalid", error); }
    let certificate;
    try { certificate = JSON.parse(String(stdout).trim().split(/\r?\n/).pop()); }
    catch (error) { throw updateError("authenticode_invalid", error); }
    if (certificate?.status !== "Valid") throw updateError("authenticode_invalid");
    if (!certificateMatchesPin(certificate, publisher, thumbprint)) throw updateError("authenticode_invalid");
    return certificate;
  }

  async prepareOffline(manifestPath, installerPath) {
    try {
      const manifest = safeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")));
      const comparison = compareSemVer(this.app.getVersion(), manifest.version);
      if (comparison === null || comparison >= 0) throw updateError("offline_version_not_newer");
      this.assertManifestApplicable(manifest);
      if (!path.isAbsolute(installerPath) || path.extname(installerPath).toLowerCase() !== ".exe") throw updateError("offline_installer_invalid");
      this.transition("update_available", { target: manifest, checkedAt: new Date().toISOString() });
      return await this.verifyInstaller(installerPath, manifest);
    } catch (error) { return this.fail(error); }
  }

  pgTool(name) {
    const extension = process.platform === "win32" ? ".exe" : "";
    return path.join(process.resourcesPath, "postgresql-tools", "bin", `${name}${extension}`);
  }

  prunePreUpdateBackups(preservePath) {
    const entries = fs.readdirSync(this.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^pre-update-.+\.dump$/.test(entry.name))
      .map((entry) => {
        const filePath = path.join(this.backupDir, entry.name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set(preservePath ? [preservePath] : []);
    for (const entry of entries) {
      if (keep.size >= PRE_UPDATE_BACKUP_RETENTION) break;
      keep.add(entry.filePath);
    }
    const removed = [];
    for (const entry of entries) {
      if (keep.has(entry.filePath)) continue;
      fs.rmSync(entry.filePath, { force: true });
      removed.push(entry.filePath);
    }
    return removed;
  }

  async createVerifiedBackup(backend) {
    if (!this.state.target || !this.state.installerPath) throw updateError("update_not_ready");
    if (!backend?.config?.pgPassword || !backend.config.pgPort) throw updateError("backup_database_unavailable");
    const safety = await backend.preUpdateSafety();
    if (safety.openShifts > 0) throw updateError("active_shift_blocks_update");
    if (safety.openOrders > 0) throw updateError("active_order_blocks_update");
    this.transition("backup_in_progress", { errorCode: null, errorDetail: null });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = path.join(this.backupDir, `pre-update-${this.app.getVersion()}-to-${this.state.target.version}-${stamp}.dump`);
    try {
      await this.commandRunner(this.pgTool("pg_dump"), [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--no-password",
        "--host=127.0.0.1",
        `--port=${backend.config.pgPort}`,
        "--username=postgres",
        "--dbname=pos",
        `--file=${backupPath}`,
      ], { env: { ...process.env, PGPASSWORD: backend.config.pgPassword } });
      const stat = fs.statSync(backupPath); if (stat.size < 1024) throw updateError("backup_empty");
      if (typeof backend.verifyPreUpdateBackup !== "function") throw updateError("backup_verifier_unavailable");
      const verification = await backend.verifyPreUpdateBackup(backupPath);
      this.logger.info("Pre-update backup restored and validated in a scratch database", {
        migrations: verification?.verified?.migrations,
        tables: verification?.verified?.tables?.length,
      });
      this.state.backupPath = backupPath; this.persist(); this.emit("state", this.publicState());
      try {
        const removed = this.prunePreUpdateBackups(backupPath);
        if (removed.length) this.logger.info("Pruned old pre-update backups", { count: removed.length });
      } catch (error) {
        this.logger.warn("Could not prune old pre-update backups", error);
      }
      return backupPath;
    } catch (error) {
      fs.rmSync(backupPath, { force: true });
      throw updateError("backup_verification_failed", error);
    }
  }

  scheduleNextRestart() {
    if (this.state.state !== "ready_to_install") throw updateError("update_not_ready");
    this.state.installOnNextRestart = true; this.persist(); this.emit("state", this.publicState()); return this.publicState();
  }

  markInstalling() {
    if (!this.state.backupPath || !fs.existsSync(this.state.backupPath)) throw updateError("verified_backup_required");
    if (!this.state.installerPath || !fs.existsSync(this.state.installerPath)) throw updateError("installer_missing");
    return this.transition("installing", { previousVersion: this.app.getVersion(), installOnNextRestart: false });
  }

  /**
   * Verify the download, copy it into the protected staging folder, verify the
   * copy and record the identity of those exact bytes. The launch that follows
   * checks that identity again and holds the file locked while Windows starts
   * it, so a replacement between verification and execution cannot run
   * (issue #1000). This is deliberately not just a second hash of the same
   * path: the path is user-writable, the staged file is checked by identity.
   */
  async stageVerifiedInstaller() {
    const manifest = this.state.target;
    const sourcePath = this.state.installerPath;
    if (!sourcePath || !fs.existsSync(sourcePath)) throw updateError("installer_missing");
    const staged = await stageInstaller({
      sourcePath,
      updatesDir: this.dir,
      version: manifest?.version,
      expectedSize: manifest.installer.size,
      commandRunner: this.commandRunner,
      logger: this.logger,
    });
    try {
      await this.verifyInstallerBytes(staged.path, manifest);
    } catch (error) {
      fs.rmSync(staged.path, { force: true });
      throw error;
    }
    try { pruneStagedInstallers(this.dir, staged.path); }
    catch (error) { this.logger.warn("Could not prune staged installers", { detail: error?.message }); }
    this.state.stagedInstaller = staged;
    this.persist();
    return staged;
  }

  async launchInstaller() {
    if (!this.state.target) throw updateError("update_target_missing");
    if (!this.state.installerPath || !fs.existsSync(this.state.installerPath)) throw updateError("installer_missing");
    await this.verifyInstallerBytes(this.state.installerPath, this.state.target);
    const staged = await this.stageVerifiedInstaller();
    this.markInstalling();
    const launched = await launchStagedInstaller({
      staged,
      installDirectory: path.dirname(process.execPath),
      sha256: this.state.target.installer.sha256,
      commandRunner: this.commandRunner,
    });
    return { state: this.transition("restarting"), installerPid: launched.installerPid };
  }

  completeStartupHealth() {
    if (!["installing", "restarting", "verifying_health"].includes(this.state.state)) return this.publicState();
    this.transition("verifying_health");
    if (this.state.target?.version === this.app.getVersion()) {
      const sequences = { ...(this.state.releaseSequences ?? {}) };
      const target = this.state.target;
      if (Number.isSafeInteger(target?.releaseSequence) && target.releaseSequence > 0) {
        sequences[target.channel] = Math.max(Number(sequences[target.channel] ?? 0), target.releaseSequence);
      }
      return this.transition("success", {
        installedVersion: this.app.getVersion(),
        errorCode: null,
        errorDetail: null,
        releaseSequences: sequences,
      });
    }
    return this.fail(updateError("post_update_version_mismatch"));
  }
}

module.exports = {
  DesktopUpdateEngine,
  canonicalManifestPayload,
  compareSemVer,
  safeManifest,
  fileSha256,
  publisherMatchesCertificate,
  thumbprintMatchesCertificate,
  certificateMatchesPin,
};
