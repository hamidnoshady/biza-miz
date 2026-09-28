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

const STATES = new Set([
  "checking", "no_update", "update_available", "downloading", "paused", "verifying",
  "ready_to_install", "backup_in_progress", "installing", "restarting",
  "verifying_health", "success", "failed", "recovery_required",
]);
const CHANNELS = new Set(["stable", "beta", "internal"]);
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

function canonicalManifestPayload(manifest) {
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

function safeManifest(value) {
  if (!value || typeof value !== "object") throw updateError("manifest_invalid");
  const manifest = value;
  if (!parseSemVer(manifest.version)) throw updateError("manifest_version_invalid");
  if (typeof manifest.manifestSignature !== "string" || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(manifest.manifestSignature)) throw updateError("manifest_signature_invalid");
  if (!CHANNELS.has(manifest.channel)) throw updateError("manifest_channel_invalid");
  if (!manifest.installer || typeof manifest.installer !== "object") throw updateError("manifest_installer_invalid");
  const url = new URL(String(manifest.installer.url || ""));
  if (url.protocol !== "https:") throw updateError("manifest_installer_url_invalid");
  if (!/^[0-9a-f]{64}$/.test(String(manifest.installer.sha256 || ""))) throw updateError("manifest_installer_hash_invalid");
  if (!Number.isSafeInteger(manifest.installer.size) || manifest.installer.size < 1) throw updateError("manifest_installer_size_invalid");
  if (manifest.installer.signatureRequired !== true) throw updateError("manifest_signature_required");
  if (typeof manifest.installer.expectedPublisher !== "string" || !manifest.installer.expectedPublisher.trim()) throw updateError("expected_publisher_missing");
  if (!manifest.database || manifest.database.backupRequired !== true) throw updateError("manifest_backup_required");
  if (!Array.isArray(manifest.releaseNotes) || !manifest.releaseNotes.every((note) => typeof note === "string")) throw updateError("manifest_release_notes_invalid");
  return JSON.parse(JSON.stringify({ ...manifest, installer: { ...manifest.installer, url: url.toString() } }));
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

class DesktopUpdateEngine extends EventEmitter {
  constructor({ app, logger, expectedPublisher, allowedOrigins, manifestPublicKey }) {
    super();
    this.app = app; this.logger = logger;
    const paths = computePaths(app.getPath("userData"));
    this.dir = path.join(paths.dataDir, "Updates");
    this.backupDir = path.join(paths.backupDir, "pre-update");
    this.statePath = path.join(paths.configDir, "update-state.json");
    this.targetPath = path.join(paths.configDir, "update-target.json");
    this.expectedPublisher = String(expectedPublisher || process.env.WINDOWS_EXPECTED_SIGNER || "").trim();
    this.manifestPublicKey = String(manifestPublicKey || process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM || "").replaceAll("\\n", "\n").trim();
    if (!this.manifestPublicKey) {
      try { this.manifestPublicKey = fs.readFileSync(path.join(__dirname, "desktop-release-public-key.pem"), "utf8").trim(); } catch { /* fail closed during verification */ }
    }
    const configured = String(process.env.DESKTOP_UPDATE_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    this.allowedOrigins = new Set([...(allowedOrigins || DEFAULT_ALLOWED_ORIGINS), ...configured]);
    this.abortController = null;
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
      installOnNextRestart: false, previousVersion: null,
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
    this.persist(); this.emit("state", this.publicState()); return this.publicState();
  }

  verifyManifestSignature(manifest) {
    if (!this.manifestPublicKey) throw updateError("manifest_public_key_missing");
    try {
      const valid = crypto.verify(
        "sha256",
        Buffer.from(canonicalManifestPayload(manifest)),
        crypto.createPublicKey(this.manifestPublicKey),
        Buffer.from(manifest.manifestSignature, "base64"),
      );
      if (!valid) throw updateError("manifest_signature_invalid");
    } catch (error) {
      if (error?.code === "manifest_signature_invalid") throw error;
      throw updateError("manifest_signature_invalid", error);
    }
  }

  checkPersistedTarget() {
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
      if (manifest.minimumSupportedVersion && compareSemVer(this.app.getVersion(), manifest.minimumSupportedVersion) < 0) {
        throw updateError("installed_version_unsupported");
      }
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
    const finalPath = path.join(this.dir, `Business-Suite-${manifest.version}-Update.exe`);
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
      const stream = fs.createWriteStream(partialPath, { flags: append ? "a" : "w", mode: 0o600 });
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > manifest.installer.size) throw updateError("download_size_mismatch");
        if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
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
    return this.transition("update_available", { progress: null, installerPath: null, backupPath: null, installOnNextRestart: false });
  }

  async verifyInstaller(installerPath, manifestValue) {
    const manifest = safeManifest(manifestValue);
    this.verifyManifestSignature(manifest);
    this.transition("verifying", { progress: null });
    const stat = fs.statSync(installerPath);
    if (stat.size !== manifest.installer.size) throw updateError("installer_size_mismatch");
    const digest = await fileSha256(installerPath);
    if (digest !== manifest.installer.sha256) throw updateError("installer_sha256_mismatch");
    await this.verifyAuthenticode(installerPath, manifest.installer.expectedPublisher);
    return this.transition("ready_to_install", { target: manifest, installerPath, errorCode: null, errorDetail: null });
  }

  async verifyAuthenticode(installerPath, manifestPublisher) {
    if (process.platform !== "win32") throw updateError("authenticode_windows_required");
    const publisher = String(manifestPublisher || this.expectedPublisher || "").trim();
    if (!publisher) throw updateError("expected_publisher_missing");
    const script = [
      "$s=Get-AuthenticodeSignature -LiteralPath $args[0]",
      "if($s.Status -ne 'Valid'){exit 10}",
      "if(-not $s.SignerCertificate){exit 11}",
      "if($s.SignerCertificate.Subject -notlike ('*'+$args[1]+'*')){exit 12}",
      "$s.SignerCertificate.Subject",
    ].join(";");
    try { await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, installerPath, publisher]); }
    catch (error) { throw updateError("authenticode_invalid", error); }
  }

  async prepareOffline(manifestPath, installerPath) {
    try {
      const manifest = safeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const comparison = compareSemVer(this.app.getVersion(), manifest.version);
      if (comparison === null || comparison >= 0) throw updateError("offline_version_not_newer");
      if (!path.isAbsolute(installerPath) || path.extname(installerPath).toLowerCase() !== ".exe") throw updateError("offline_installer_invalid");
      this.transition("update_available", { target: manifest, checkedAt: new Date().toISOString() });
      return await this.verifyInstaller(installerPath, manifest);
    } catch (error) { return this.fail(error); }
  }

  pgTool(name) {
    const extension = process.platform === "win32" ? ".exe" : "";
    return path.join(process.resourcesPath, "postgresql-tools", "bin", `${name}${extension}`);
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
    const databaseUrl = `postgres://postgres:${encodeURIComponent(backend.config.pgPassword)}@127.0.0.1:${backend.config.pgPort}/pos`;
    try {
      await run(this.pgTool("pg_dump"), ["--format=custom", "--no-owner", "--no-acl", `--file=${backupPath}`, databaseUrl]);
      const stat = fs.statSync(backupPath); if (stat.size < 1024) throw updateError("backup_empty");
      await run(this.pgTool("pg_restore"), ["--list", backupPath]);
      this.state.backupPath = backupPath; this.persist(); this.emit("state", this.publicState());
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

  launchInstaller() {
    this.markInstalling();
    const installDirectory = path.dirname(process.execPath);
    const child = spawn(this.state.installerPath, ["/S", `/D=${installDirectory}`], {
      detached: true, windowsHide: false, stdio: "ignore",
    });
    child.unref();
    return this.transition("restarting");
  }

  completeStartupHealth() {
    if (!["installing", "restarting", "verifying_health"].includes(this.state.state)) return this.publicState();
    this.transition("verifying_health");
    if (this.state.target?.version === this.app.getVersion()) {
      return this.transition("success", { installedVersion: this.app.getVersion(), errorCode: null, errorDetail: null });
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
};
