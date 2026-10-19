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
  isDesktopReleaseChannel,
  isDesktopUpdateState,
  parseSemVer,
  type DesktopReleaseChannel,
  type DesktopReleaseIdentity,
  type DesktopReleaseManifest,
  type DeviceComplianceStatus,
} from "./desktop-release";
import { computeUpdateStatus } from "./app-update-status";
import type { DesktopUpdatePolicyDocument } from "./desktop-update-policy";

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
  reportedAt: string;
}

export interface AppUpdateStatus {
  checkedAt: string;
  installed: DesktopReleaseIdentity;
  centralRuntime: CentralRuntimeIdentity | null;
  targetRelease: DesktopReleaseManifest | null;
  compliance: DeviceComplianceStatus;
  error: string | null;
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
}> {
  const empty = {
    updateState: null, updateTargetVersion: null, lastErrorCode: null, lastErrorMessage: null,
    appliedPolicyVersion: null,
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
    currentVersion: input.installed.version,
    latestVersion: target?.version ?? null,
    updateAvailable: compliance === "update_available",
  };
}

/**
 * Called by the 30-second site sync tick.  The credential determines the
 * device server-side; no siteDeviceId from this payload is accepted.
 */
export async function refreshAppUpdateStatus(
  businessId: string,
  config: ServerSyncConfig | null,
): Promise<AppUpdateStatus> {
  const policy = await getDesktopUpdatePolicy(businessId);
  const installed = currentDesktopIdentity(policy.channel);
  const save = async (status: AppUpdateStatus): Promise<AppUpdateStatus> => {
    await setSetting(businessId, SETTING_KEYS.appUpdateStatus, status);
    return status;
  };

  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return save(statusFrom({ installed, error: "sync_not_configured" }));
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
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return save(statusFrom({ installed, error: `remote_rejected_${res.status}` }));
    }
    const body = (await res.json()) as UpdateCheckResponse;
    await persistDesktopUpdateTarget(body.targetRelease);
    await persistDesktopUpdatePolicy(body.updatePolicy, businessId);
    return save(statusFrom({
      installed,
      checkedAt: body.reportedAt,
      centralRuntime: body.centralRuntime,
      targetRelease: body.targetRelease,
    }));
  } catch (error) {
    return save(statusFrom({
      installed,
      error: error instanceof Error && error.name === "TimeoutError" ? "remote_timeout" : "remote_unreachable",
    }));
  }
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
  return summarizeUpdateCheck(await refreshAppUpdateStatus(businessId, config));
}
