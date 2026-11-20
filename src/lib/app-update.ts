/**
 * Desktop release discovery over the authenticated site-sync relationship.
 *
 * The site reports its canonical Desktop identity to Central.  Central stores
 * it under the credential's site-device identity, selects a channel/rollout
 * target and returns a release manifest.  Docker runtime SHA is returned as
 * separate provenance and is never compared to Desktop SemVer.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { query } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import {
  compareSemVer,
  isDesktopReleaseChannel,
  isDesktopUpdateState,
  parseSemVer,
  validateDesktopReleaseManifest,
  type DesktopReleaseChannel,
  type DesktopReleaseIdentity,
  type DesktopReleaseManifest,
  type DeviceComplianceStatus,
} from "./desktop-release";
import { computeUpdateStatus } from "./app-update-status";
import type { DesktopUpdatePolicyDocument } from "./desktop-update-policy";
import type { DesktopUpdateCommandDocument, DesktopUpdateCommandResult } from "./desktop-update-command";

export interface CentralRuntimeIdentity {
  releaseVersion: string | null;
  commitSha: string | null;
  buildId: string | null;
}

function shaOrNull(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

export function currentCentralRuntime(): CentralRuntimeIdentity {
  const releaseVersion = process.env.APP_RELEASE_VERSION?.trim() ?? "";
  return {
    releaseVersion: parseSemVer(releaseVersion) ? releaseVersion : null,
    commitSha: shaOrNull(process.env.APP_BUILD_COMMIT) ?? shaOrNull(process.env.APP_IMAGE_SHA),
    buildId: process.env.APP_BUILD_ID?.trim() || null,
  };
}

/** The identity packaged by Electron. Unknown development builds stay unknown. */
export function currentDesktopIdentity(channelOverride?: DesktopReleaseChannel): DesktopReleaseIdentity {
  const version = process.env.APP_RELEASE_VERSION?.trim() ?? "";
  const channelValue = process.env.DESKTOP_RELEASE_CHANNEL?.trim();
  const channel: DesktopReleaseChannel = channelOverride ?? (isDesktopReleaseChannel(channelValue) ? channelValue : "stable");
  return {
    version: parseSemVer(version) ? version : "unknown",
    buildCommit:
      shaOrNull(process.env.APP_BUILD_COMMIT) ?? shaOrNull(process.env.GIT_COMMIT) ?? "unknown",
    buildId: process.env.APP_BUILD_ID?.trim() || (parseSemVer(version) ? `desktop-${version}` : "unknown"),
    channel,
  };
}

const PACKAGE_VERSION = "0.1.0";

/** Kept for health diagnostics and MCP serverInfo.version; update ordering must use currentDesktopIdentity().version. */
export function currentAppVersion(): string {
  const desktop = currentDesktopIdentity();
  if (desktop.version !== "unknown") return desktop.version;
  const baseVersion =
    (parseSemVer(process.env.npm_package_version?.trim() ?? "")
      ? process.env.npm_package_version!.trim()
      : null) ?? PACKAGE_VERSION;
  const sha =
    shaOrNull(process.env.APP_BUILD_COMMIT) ??
    shaOrNull(process.env.APP_IMAGE_SHA) ??
    shaOrNull(process.env.GIT_COMMIT);
  return sha ? `${baseVersion}+${sha.slice(0, 7)}` : baseVersion;
}

export interface UpdateCheckResponse {
  centralRuntime: CentralRuntimeIdentity;
  targetRelease: DesktopReleaseManifest | null;
  /** Absent from an older Central; the device then keeps its own defaults. */
  updatePolicy?: DesktopUpdatePolicyDocument | null;
  updateCommand?: DesktopUpdateCommandDocument | null;
  reportedAt: string;
}

export interface AppUpdateStatus {
  checkedAt: string;
  installed: DesktopReleaseIdentity;
  centralRuntime: CentralRuntimeIdentity | null;
  targetRelease: DesktopReleaseManifest | null;
  compliance: DeviceComplianceStatus;
  error: string | null;
  /** Which feed answered: Bizamiz Central or the GitHub release feed. */
  source?: UpdateSource | null;
  /** Compatibility fields for older packaged web runtimes during in-place update. */
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface DesktopUpdatePolicy {
  automaticChecks: boolean;
  backgroundDownload: boolean;
  automaticInstall: false;
  channel: DesktopReleaseChannel;
}

const DEFAULT_UPDATE_POLICY: DesktopUpdatePolicy = {
  automaticChecks: true,
  backgroundDownload: false,
  automaticInstall: false,
  channel: "stable",
};

export async function getDesktopUpdatePolicy(businessId: string): Promise<DesktopUpdatePolicy> {
  const stored = await getSetting<Partial<DesktopUpdatePolicy>>(businessId, SETTING_KEYS.desktopUpdatePolicy);
  return {
    ...DEFAULT_UPDATE_POLICY,
    automaticChecks: stored?.automaticChecks !== false,
    backgroundDownload: stored?.backgroundDownload === true,
    channel: isDesktopReleaseChannel(stored?.channel) ? stored.channel : DEFAULT_UPDATE_POLICY.channel,
  };
}

export async function setDesktopUpdatePolicy(businessId: string, policy: DesktopUpdatePolicy): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.desktopUpdatePolicy, { ...policy, automaticInstall: false });
}

export async function getAppUpdateStatus(businessId: string): Promise<AppUpdateStatus | null> {
  return getSetting<AppUpdateStatus>(businessId, SETTING_KEYS.appUpdateStatus);
}

function remoteUrlFor(config: ServerSyncConfig, path: string): string {
  return `${config.remoteUrl.trim().replace(/\/+$/, "")}${path}`;
}

async function currentSchemaVersion(): Promise<number | null> {
  try {
    const { rows } = await query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY applied_at DESC, filename DESC LIMIT 1`,
    );
    const match = rows[0]?.filename.match(/^(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function readDesktopEngineTelemetry(statePath = process.env.DESKTOP_UPDATE_STATE_PATH?.trim()): Promise<{
  updateState: string | null;
  updateTargetVersion: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  appliedPolicyVersion: number | null;
  commandResults: DesktopUpdateCommandResult[];
}> {
  const empty = {
    updateState: null, updateTargetVersion: null, lastErrorCode: null, lastErrorMessage: null,
    appliedPolicyVersion: null, commandResults: [] as DesktopUpdateCommandResult[],
  };
  if (!statePath || !path.isAbsolute(statePath) || path.basename(statePath) !== "update-state.json") return empty;
  try {
    const metadata = await stat(statePath);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 64 * 1024) return empty;
    const value = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const target = value.target && typeof value.target === "object" ? value.target as Record<string, unknown> : null;
    return {
      updateState: isDesktopUpdateState(value.state) ? value.state : null,
      updateTargetVersion: typeof target?.version === "string" && parseSemVer(target.version) ? target.version : null,
      lastErrorCode: typeof value.errorCode === "string" ? value.errorCode.slice(0, 120) : null,
      lastErrorMessage: typeof value.errorDetail === "string" ? value.errorDetail.slice(0, 1_000) : null,
      appliedPolicyVersion: appliedPolicyVersionFrom(value.centralPolicy),
      commandResults: Array.isArray(value.commandResults)
        ? value.commandResults.filter((item): item is DesktopUpdateCommandResult => Boolean(item && typeof item === "object")).slice(-20)
        : [],
    };
  } catch {
    return empty;
  }
}

function appliedPolicyVersionFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const version = (value as Record<string, unknown>).policyVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : null;
}

/**
 * Hands Central's resolved policy to the Electron engine through a narrow local
 * file, exactly like the target. It is written only for the business this
 * backend belongs to; the engine re-validates every field and refuses an older
 * version, so a stale or foreign document changes nothing.
 */
export async function persistDesktopUpdatePolicy(
  document: DesktopUpdatePolicyDocument | null | undefined,
  businessId: string,
  policyPath = process.env.DESKTOP_UPDATE_POLICY_PATH?.trim(),
): Promise<boolean> {
  if (!document || document.schemaVersion !== 1 || document.businessId !== businessId) return false;
  if (!policyPath || !path.isAbsolute(policyPath) || path.basename(policyPath) !== "update-policy.json") return false;
  try {
    const content = JSON.stringify(document);
    if (Buffer.byteLength(content) > 16 * 1024) return false;
    await mkdir(path.dirname(policyPath), { recursive: true });
    const temporary = `${policyPath}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, policyPath);
    return true;
  } catch {
    return false;
  }
}

export async function persistDesktopUpdateCommand(
  command: DesktopUpdateCommandDocument | null | undefined,
  businessId: string,
  commandPath = process.env.DESKTOP_UPDATE_COMMAND_PATH?.trim(),
): Promise<boolean> {
  if (!command || command.schemaVersion !== 1 || command.businessId !== businessId) return false;
  if (!commandPath || !path.isAbsolute(commandPath) || path.basename(commandPath) !== "update-command.json") return false;
  try {
    const content = JSON.stringify(command);
    if (Buffer.byteLength(content) > 8 * 1024) return false;
    await mkdir(path.dirname(commandPath), { recursive: true });
    const temporary = `${commandPath}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, commandPath);
    return true;
  } catch { return false; }
}

export async function persistDesktopUpdateTarget(
  target: DesktopReleaseManifest | null,
  targetPath = process.env.DESKTOP_UPDATE_TARGET_PATH?.trim(),
): Promise<boolean> {
  if (!targetPath || !path.isAbsolute(targetPath) || path.basename(targetPath) !== "update-target.json") return false;
  try {
    const content = JSON.stringify(target);
    if (Buffer.byteLength(content) > 64 * 1024) return false;
    await mkdir(path.dirname(targetPath), { recursive: true });
    const temporary = `${targetPath}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, targetPath);
    return true;
  } catch {
    return false;
  }
}

function statusFrom(input: {
  installed: DesktopReleaseIdentity;
  checkedAt?: string;
  centralRuntime?: CentralRuntimeIdentity | null;
  targetRelease?: DesktopReleaseManifest | null;
  error?: string | null;
  source?: UpdateSource | null;
}): AppUpdateStatus {
  const target = input.targetRelease ?? null;
  const compliance = input.error
    ? "error"
    : computeUpdateStatus(
        input.installed.version,
        target?.version ?? null,
        target?.minimumSupportedVersion ?? null,
      );
  return {
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    installed: input.installed,
    centralRuntime: input.centralRuntime ?? null,
    targetRelease: target,
    compliance,
    error: input.error ?? null,
    source: input.source ?? null,
    currentVersion: input.installed.version,
    latestVersion: target?.version ?? null,
    updateAvailable: compliance === "update_available",
  };
}

/** The repository whose GitHub Releases are the release feed. */
export const DESKTOP_RELEASES_REPO = "hamidnoshady/biza-miz";
const GITHUB_API = `https://api.github.com/repos/${DESKTOP_RELEASES_REPO}`;
/** Stable builds are `desktop-vX.Y.Z`; other channels keep their own prefix. */
const GITHUB_RELEASE_TAGS: Record<DesktopReleaseChannel, RegExp> = {
  stable: /^desktop-v([0-9]+\.[0-9]+\.[0-9]+)$/,
  beta: /^desktop-beta-v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/,
  internal: /^desktop-internal-v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/,
};
/**
 * Unauthenticated GitHub API calls are rate limited per address, and the sync
 * tick runs every 30 seconds, so a GitHub answer is reused for hours. A manual
 * "check for updates" bypasses this on purpose.
 */
const GITHUB_CHECK_TTL_MS = 6 * 60 * 60_000;
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function githubReleaseVersion(tag: unknown, channel: DesktopReleaseChannel): string | null {
  const match = typeof tag === "string" ? tag.trim().match(GITHUB_RELEASE_TAGS[channel]) : null;
  return match ? match[1] : null;
}

function githubDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && GITHUB_DOWNLOAD_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The newest published GitHub release for a channel: the signed
 * `release-manifest.json` attached by the release workflow. Nothing is trusted
 * here beyond fetching it — the Electron engine verifies the manifest
 * signature, the installer SHA-256 and the Authenticode pin before it ever
 * downloads or installs anything.
 */
export async function fetchDesktopReleaseFromGitHub(
  channel: DesktopReleaseChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<{ manifest: DesktopReleaseManifest | null; error: string | null }> {
  const headers = { Accept: GITHUB_ACCEPT, "User-Agent": "bizamiz-desktop-updates" };
  let releases: unknown;
  try {
    const response = await fetchImpl(`${GITHUB_API}/releases?per_page=30`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { manifest: null, error: `github_releases_http_${response.status}` };
    releases = await response.json();
  } catch {
    return { manifest: null, error: "github_releases_unreachable" };
  }
  if (!Array.isArray(releases)) return { manifest: null, error: "github_releases_invalid" };

  const candidates = releases
    .map((release) => ({ release, version: githubReleaseVersion((release as Record<string, unknown>)?.tag_name, channel) }))
    .filter((item): item is { release: Record<string, unknown>; version: string } => Boolean(item.version))
    .filter(({ release }) => release.draft !== true && release.prerelease !== true)
    .sort((a, b) => (compareSemVer(b.version, a.version) ?? 0));
  if (candidates.length === 0) return { manifest: null, error: "github_release_not_found" };

  const { release, version } = candidates[0];
  const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : [];
  const asset = assets.find((item) => item?.name === "release-manifest.json");
  const manifestUrl = githubDownloadUrl(asset?.browser_download_url);
  if (!manifestUrl) return { manifest: null, error: "github_manifest_missing" };

  let body: unknown;
  try {
    const response = await fetchImpl(manifestUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { manifest: null, error: `github_manifest_http_${response.status}` };
    body = await response.json();
  } catch {
    return { manifest: null, error: "github_manifest_unreachable" };
  }

  const parsed = validateDesktopReleaseManifest(body);
  if (!parsed.ok) return { manifest: null, error: parsed.error };
  if (parsed.manifest.channel !== channel) return { manifest: null, error: "github_release_channel_mismatch" };
  if (parsed.manifest.version !== version) return { manifest: null, error: "github_release_version_mismatch" };
  if (!parseSemVer(parsed.manifest.version)) return { manifest: null, error: "github_release_version_mismatch" };
  return { manifest: parsed.manifest, error: null };
}

/**
 * Resolves a release from GitHub Releases, reusing the last answer while it is
 * fresh. The returned status and the persisted target are the same handoff the
 * Central exchange produces, so the Electron engine cannot tell the two feeds
 * apart — it still validates everything itself.
 */
async function resolveGitHubDesktopUpdate(
  businessId: string,
  installed: DesktopReleaseIdentity,
  force: boolean,
): Promise<{ status: AppUpdateStatus | null; error: string | null }> {
  if (!force) {
    const cached = await getAppUpdateStatus(businessId);
    if (cached?.source === "github") {
      const checkedAt = Date.parse(cached.checkedAt);
      if (Number.isFinite(checkedAt) && Date.now() - checkedAt < GITHUB_CHECK_TTL_MS) {
        // The target file may have been removed with the profile; rewriting it is idempotent.
        await persistDesktopUpdateTarget(cached.targetRelease ?? null);
        return {
          status: statusFrom({
            installed,
            checkedAt: cached.checkedAt,
            targetRelease: cached.targetRelease ?? null,
            source: "github",
          }),
          error: null,
        };
      }
    }
  }
  const { manifest, error } = await fetchDesktopReleaseFromGitHub(installed.channel);
  if (!manifest) return { status: null, error };
  await persistDesktopUpdateTarget(manifest);
  return { status: statusFrom({ installed, targetRelease: manifest, source: "github" }), error: null };
}

/**
 * Called by the 30-second site sync tick.  The credential determines the
 * device server-side; no siteDeviceId from this payload is accepted.
 */
export async function refreshAppUpdateStatus(
  businessId: string,
  config: ServerSyncConfig | null,
  options: { forceGitHubCheck?: boolean } = {},
): Promise<AppUpdateStatus> {
  const policy = await getDesktopUpdatePolicy(businessId);
  const installed = currentDesktopIdentity(policy.channel);
  const save = async (status: AppUpdateStatus): Promise<AppUpdateStatus> => {
    await setSetting(businessId, SETTING_KEYS.appUpdateStatus, status);
    return status;
  };

  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    const github = await resolveGitHubDesktopUpdate(businessId, installed, options.forceGitHubCheck === true);
    if (github.status) return save(github.status);
    return save(statusFrom({ installed, error: github.error ?? "sync_not_configured" }));
  }

  const engineTelemetry = await readDesktopEngineTelemetry();
  try {
    const res = await fetch(remoteUrlFor(config, "/api/server-sync/runtime-status"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appVersion: parseSemVer(installed.version) ? installed.version : null,
        commitSha: installed.buildCommit === "unknown" ? null : installed.buildCommit,
        buildId: installed.buildId === "unknown" ? null : installed.buildId,
        schemaVersion: await currentSchemaVersion(),
        electronVersion: process.env.ELECTRON_VERSION?.trim() || null,
        platform: process.platform,
        releaseChannel: installed.channel,
        clientCheckedAt: new Date().toISOString(),
        updateState: engineTelemetry.updateState,
        updateTargetVersion: engineTelemetry.updateTargetVersion,
        lastErrorCode: engineTelemetry.lastErrorCode,
        lastErrorMessage: engineTelemetry.lastErrorMessage,
        appliedPolicyVersion: engineTelemetry.appliedPolicyVersion,
        commandResults: engineTelemetry.commandResults,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return save(await fallBackToGitHub(businessId, installed, options, `remote_rejected_${res.status}`));
    }
    const body = (await res.json()) as UpdateCheckResponse;
    await persistDesktopUpdateTarget(body.targetRelease);
    await persistDesktopUpdatePolicy(body.updatePolicy, businessId);
    await persistDesktopUpdateCommand(body.updateCommand, businessId);
    return save(statusFrom({
      installed,
      checkedAt: body.reportedAt,
      centralRuntime: body.centralRuntime,
      targetRelease: body.targetRelease,
      source: "central",
    }));
  } catch (error) {
    const centralError = error instanceof Error && error.name === "TimeoutError" ? "remote_timeout" : "remote_unreachable";
    return save(await fallBackToGitHub(businessId, installed, options, centralError));
  }
}

/**
 * Central unreachable or refusing: try the GitHub release feed before reporting
 * a failure. The device keeps updating straight from versioned GitHub releases
 * when Central is down, and the engine's signature/size/publisher pins are
 * unchanged.
 */
async function fallBackToGitHub(
  businessId: string,
  installed: DesktopReleaseIdentity,
  options: { forceGitHubCheck?: boolean },
  centralError: string,
): Promise<AppUpdateStatus> {
  const github = await resolveGitHubDesktopUpdate(businessId, installed, options.forceGitHubCheck === true);
  if (github.status) return github.status;
  return statusFrom({ installed, error: centralError });
}

/**
 * Issue #1008 — the manual "check for updates" path.
 *
 * `refreshAppUpdateStatus` above is the exchange the 30-second sync tick runs.
 * Nothing invoked it on demand, so the settings button could only re-evaluate
 * whatever target the last tick had pushed into `Configuration/update-target.json`;
 * with no pushed target it said «no update» without asking Central anything.
 * `checkDesktopUpdateNow` runs the same authenticated runtime-status exchange
 * immediately — outside the tick's interval — and `summarizeUpdateCheck` turns
 * its stored outcome into the one shape the settings screen renders.
 */
export type UpdateSource = "central" | "github";

export type UpdateCheckOutcome = "update_available" | "up_to_date" | "offline" | "error";

export interface DesktopUpdateCheck {
  /** The status the refresh just persisted for this business. */
  status: AppUpdateStatus;
  /** The manifest Central returned on this exchange; null when it returned none. */
  targetRelease: DesktopReleaseManifest | null;
  checkedAt: string;
  /**
   * True only when Central could not be reached at all. A Central answer of
   * "no newer release" is `up_to_date`, never `offline`.
   */
  offline: boolean;
  /** Machine-readable reason when there was no usable answer from Central. */
  error: string | null;
  outcome: UpdateCheckOutcome;
}

export function summarizeUpdateCheck(status: AppUpdateStatus): DesktopUpdateCheck {
  const error = status.error;
  return {
    status,
    targetRelease: status.targetRelease ?? null,
    checkedAt: status.checkedAt,
    offline: error === "remote_unreachable",
    error,
    outcome: error
      ? error === "remote_unreachable" ? "offline" : "error"
      : status.updateAvailable ? "update_available" : "up_to_date",
  };
}

export async function checkDesktopUpdateNow(
  businessId: string,
  config: ServerSyncConfig | null,
): Promise<DesktopUpdateCheck> {
  return summarizeUpdateCheck(await refreshAppUpdateStatus(businessId, config, { forceGitHubCheck: true }));
}
