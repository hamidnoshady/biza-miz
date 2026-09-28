/**
 * Desktop release catalogue, authenticated device telemetry and fleet
 * compliance.  Clients report facts; Central alone selects a target and
 * calculates whether a device is current.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { query, withoutTenantScope } from "./db";
import { isUuid } from "./uuid";
import {
  canonicalDesktopManifestPayload,
  classifyDesktopVersion,
  classifyDeviceConnectivity,
  compareSemVer,
  complianceWithFreshness,
  isDesktopReleaseChannel,
  isDesktopUpdateState,
  parseSemVer,
  type DesktopReleaseChannel,
  type DesktopReleaseManifest,
  type DesktopUpdateState,
  type DeviceComplianceStatus,
  type DeviceConnectivity,
} from "./desktop-release";

export type ReleaseLifecycleStatus = "draft" | "published" | "paused" | "withdrawn";
export type ReleaseRolloutState = "internal" | "pilot" | "percentage" | "full" | "paused";

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  version: string;
  build_commit: string;
  build_id: string;
  channel: DesktopReleaseChannel;
  status: ReleaseLifecycleStatus;
  rollout_state: ReleaseRolloutState;
  rollout_percentage: number;
  released_at: Date | string | null;
  minimum_supported_version: string | null;
  mandatory: boolean;
  installer_url: string;
  installer_sha256: string;
  installer_size: string | number;
  manifest_signature: string;
  signature_required: boolean;
  expected_publisher: string | null;
  migration_version: number | null;
  minimum_schema_version: number | null;
  maximum_schema_version: number | null;
  backup_required: boolean;
  release_notes: unknown;
  recovery_notes: string | null;
  known_good_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PlatformDesktopRelease extends DesktopReleaseManifest {
  id: string;
  status: ReleaseLifecycleStatus;
  rolloutState: ReleaseRolloutState;
  rolloutPercentage: number;
  createdAt: string;
  updatedAt: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function releaseNotes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function rowToRelease(row: ReleaseRow): PlatformDesktopRelease {
  return {
    id: row.id,
    manifestSignature: row.manifest_signature,
    version: row.version,
    buildCommit: row.build_commit,
    buildId: row.build_id,
    channel: row.channel,
    status: row.status,
    rolloutState: row.rollout_state,
    rolloutPercentage: Number(row.rollout_percentage),
    releasedAt: row.released_at ? iso(row.released_at) : iso(row.created_at),
    minimumSupportedVersion: row.minimum_supported_version,
    mandatory: row.mandatory,
    installer: {
      url: row.installer_url,
      sha256: row.installer_sha256,
      size: Number(row.installer_size),
      signatureRequired: row.signature_required,
      expectedPublisher: row.expected_publisher,
    },
    database: {
      migrationVersion: row.migration_version,
      minimumSchemaVersion: row.minimum_schema_version,
      maximumSchemaVersion: row.maximum_schema_version,
      backupRequired: row.backup_required,
    },
    releaseNotes: releaseNotes(row.release_notes),
    recovery: { knownGoodVersion: row.known_good_version, notes: row.recovery_notes },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const RELEASE_SELECT = `
  SELECT r.id,r.version,r.build_commit,r.build_id,r.channel,r.status,r.rollout_state,
         r.rollout_percentage,r.released_at,r.minimum_supported_version,r.mandatory,
         r.installer_url,r.installer_sha256,r.installer_size,r.manifest_signature,r.signature_required,
         r.expected_publisher,r.migration_version,r.minimum_schema_version,
         r.maximum_schema_version,r.backup_required,r.release_notes,r.recovery_notes,
         kg.version AS known_good_version,r.created_at,r.updated_at
    FROM platform_releases r
    LEFT JOIN platform_releases kg ON kg.id=r.known_good_release_id`;

async function releaseRows(): Promise<ReleaseRow[]> {
  const { rows } = await query<ReleaseRow>(`${RELEASE_SELECT} ORDER BY r.created_at DESC`);
  return rows;
}

export async function listDesktopReleases(): Promise<PlatformDesktopRelease[]> {
  return withoutTenantScope("platform", async () => (await releaseRows()).map(rowToRelease));
}

function rolloutBucket(publicDeviceId: string, releaseId: string): number {
  const digest = createHash("sha256").update(`${releaseId}:${publicDeviceId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function releaseTargetsDevice(release: PlatformDesktopRelease, publicDeviceId: string): boolean {
  if (release.status !== "published") return false;
  if (release.rolloutState === "paused" || release.rolloutState === "internal") return false;
  if (release.rolloutState === "full") return true;
  return rolloutBucket(publicDeviceId, release.id) < release.rolloutPercentage;
}

export function selectTargetRelease(
  releases: PlatformDesktopRelease[],
  channel: DesktopReleaseChannel,
  publicDeviceId: string,
): PlatformDesktopRelease | null {
  const candidates = releases
    .filter((release) => release.channel === channel && releaseTargetsDevice(release, publicDeviceId))
    .filter((release) => parseSemVer(release.version))
    .sort((left, right) => -(compareSemVer(left.version, right.version) ?? 0));
  return candidates[0] ?? null;
}

export interface RuntimeStatusReport {
  appVersion: string | null;
  commitSha: string | null;
  buildId: string | null;
  schemaVersion: number | null;
  electronVersion: string | null;
  platform: string | null;
  releaseChannel: DesktopReleaseChannel;
  clientCheckedAt: string | null;
  updateState: DesktopUpdateState | null;
  updateTargetVersion: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

function optionalText(value: unknown, maximum = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export function validateRuntimeStatusReport(value: unknown):
  | { ok: true; report: RuntimeStatusReport }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "bad_request" };
  const input = value as Record<string, unknown>;
  const appVersion = optionalText(input.appVersion, 80);
  if (appVersion && !parseSemVer(appVersion)) return { ok: false, error: "invalid_app_version" };
  const releaseChannel = input.releaseChannel ?? "stable";
  if (!isDesktopReleaseChannel(releaseChannel)) return { ok: false, error: "invalid_release_channel" };
  const schemaVersion = input.schemaVersion === null || input.schemaVersion === undefined
    ? null
    : Number(input.schemaVersion);
  if (schemaVersion !== null && (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
    return { ok: false, error: "invalid_schema_version" };
  }
  const clientCheckedAt = optionalText(input.clientCheckedAt, 80);
  if (clientCheckedAt && !Number.isFinite(Date.parse(clientCheckedAt))) {
    return { ok: false, error: "invalid_checked_at" };
  }
  const updateState = input.updateState === null || input.updateState === undefined
    ? null
    : input.updateState;
  if (updateState !== null && !isDesktopUpdateState(updateState)) {
    return { ok: false, error: "invalid_update_state" };
  }
  const updateTargetVersion = optionalText(input.updateTargetVersion, 80);
  if (updateTargetVersion && !parseSemVer(updateTargetVersion)) {
    return { ok: false, error: "invalid_target_version" };
  }
  return {
    ok: true,
    report: {
      appVersion,
      commitSha: optionalText(input.commitSha, 80),
      buildId: optionalText(input.buildId, 200),
      schemaVersion,
      electronVersion: optionalText(input.electronVersion, 80),
      platform: optionalText(input.platform, 80),
      releaseChannel,
      clientCheckedAt,
      updateState,
      updateTargetVersion,
      lastErrorCode: optionalText(input.lastErrorCode, 120),
      // Technical detail is deliberately capped and shown only in expandable
      // diagnostics in the console.
      lastErrorMessage: optionalText(input.lastErrorMessage, 1_000),
    },
  };
}

/** Must run in the authenticated device's tenant scope. */
export async function reportDeviceRuntimeStatus(identity: {
  businessId: string;
  siteDeviceId: string;
  locationId: string;
}, report: RuntimeStatusReport): Promise<{ reportedAt: string }> {
  const previous = await query<{ update_state: string | null; update_target_version: string | null; last_error_code: string | null }>(
    `SELECT update_state,update_target_version,last_error_code
       FROM site_device_runtime_status
      WHERE site_device_id=$1 AND business_id=$2`,
    [identity.siteDeviceId, identity.businessId],
  );
  const { rows } = await query<{ reported_at: Date | string }>(
    `INSERT INTO site_device_runtime_status
       (site_device_id,business_id,location_id,app_version,commit_sha,build_id,
        schema_version,electron_version,platform,release_channel,client_checked_at,
        reported_at,update_state,update_target_version,last_error_code,last_error_message,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13,$14,$15,now())
     ON CONFLICT (site_device_id) DO UPDATE SET
       business_id=EXCLUDED.business_id,location_id=EXCLUDED.location_id,
       app_version=EXCLUDED.app_version,commit_sha=EXCLUDED.commit_sha,build_id=EXCLUDED.build_id,
       schema_version=EXCLUDED.schema_version,electron_version=EXCLUDED.electron_version,
       platform=EXCLUDED.platform,release_channel=EXCLUDED.release_channel,
       client_checked_at=EXCLUDED.client_checked_at,reported_at=now(),
       update_state=EXCLUDED.update_state,update_target_version=EXCLUDED.update_target_version,
       last_error_code=EXCLUDED.last_error_code,last_error_message=EXCLUDED.last_error_message,
       updated_at=now()
     RETURNING reported_at`,
    [
      identity.siteDeviceId, identity.businessId, identity.locationId,
      report.appVersion, report.commitSha, report.buildId, report.schemaVersion,
      report.electronVersion, report.platform, report.releaseChannel,
      report.clientCheckedAt, report.updateState, report.updateTargetVersion,
      report.lastErrorCode, report.lastErrorMessage,
    ],
  );
  const prior = previous.rows[0];
  if (
    report.updateState &&
    (!prior || prior.update_state !== report.updateState ||
      prior.update_target_version !== report.updateTargetVersion || prior.last_error_code !== report.lastErrorCode)
  ) {
    await recordDeviceUpdateEvent(
      { businessId: identity.businessId, siteDeviceId: identity.siteDeviceId },
      {
        releaseId: null,
        installedVersion: report.appVersion,
        targetVersion: report.updateTargetVersion,
        state: report.updateState,
        errorCode: report.lastErrorCode,
        detail: report.lastErrorMessage ? { message: report.lastErrorMessage } : {},
        clientOccurredAt: report.clientCheckedAt,
      },
    );
  }
  return { reportedAt: iso(rows[0].reported_at) };
}

export interface DeviceUpdateEventInput {
  releaseId: string | null;
  installedVersion: string | null;
  targetVersion: string | null;
  state: DesktopUpdateState;
  errorCode: string | null;
  detail: Record<string, unknown>;
  clientOccurredAt: string | null;
}

/** Must run in the authenticated device's tenant scope. */
export async function recordDeviceUpdateEvent(
  identity: { businessId: string; siteDeviceId: string },
  event: DeviceUpdateEventInput,
): Promise<void> {
  await query(
    `INSERT INTO site_device_update_events
       (site_device_id,business_id,release_id,installed_version,target_version,state,
        error_code,detail,client_occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [identity.siteDeviceId, identity.businessId, event.releaseId, event.installedVersion,
      event.targetVersion, event.state, event.errorCode, JSON.stringify(event.detail), event.clientOccurredAt],
  );
}

type FleetRow = Record<string, unknown> & {
  site_device_id: string;
  public_id: string;
  business_id: string;
  business_name: string;
  location_id: string;
  location_name: string;
  display_name: string;
  device_status: string;
  revoked_at: Date | string | null;
  last_seen_at: Date | string | null;
  app_version: string | null;
  commit_sha: string | null;
  build_id: string | null;
  schema_version: number | null;
  electron_version: string | null;
  platform: string | null;
  release_channel: DesktopReleaseChannel | null;
  client_checked_at: Date | string | null;
  reported_at: Date | string | null;
  update_state: string | null;
  update_target_version: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_push_at: Date | string | null;
  last_pull_at: Date | string | null;
  update_events: Array<{
    state: string;
    installedVersion: string | null;
    targetVersion: string | null;
    errorCode: string | null;
    clientOccurredAt: string | null;
    reportedAt: string;
  }>;
};

export interface FleetDeviceStatus {
  siteDeviceId: string;
  publicId: string;
  businessId: string;
  businessName: string;
  locationId: string;
  locationName: string;
  deviceName: string;
  deviceStatus: string;
  revoked: boolean;
  installedVersion: string | null;
  buildCommit: string | null;
  buildId: string | null;
  schemaVersion: number | null;
  electronVersion: string | null;
  platform: string | null;
  channel: DesktopReleaseChannel;
  targetRelease: PlatformDesktopRelease | null;
  compliance: DeviceComplianceStatus;
  connectivity: DeviceConnectivity;
  lastSeenAt: string | null;
  lastReportAt: string | null;
  clientCheckedAt: string | null;
  lastSuccessfulPushAt: string | null;
  lastSuccessfulPullAt: string | null;
  updateState: string | null;
  updateTargetVersion: string | null;
  error: { code: string; message: string | null } | null;
  updateEvents: Array<{
    state: string;
    installedVersion: string | null;
    targetVersion: string | null;
    errorCode: string | null;
    clientOccurredAt: string | null;
    reportedAt: string;
  }>;
}

function maybeIso(value: Date | string | null): string | null {
  return value ? iso(value) : null;
}

export interface FleetUpdateSummary {
  installations: number;
  upToDate: number;
  updateAvailable: number;
  offline: number;
  problems: number;
}

export async function desktopFleetCompliance(now: Date = new Date()): Promise<{
  devices: FleetDeviceStatus[];
  releases: PlatformDesktopRelease[];
  summary: FleetUpdateSummary;
}> {
  return withoutTenantScope("platform", async () => {
    const [runtime, releases] = await Promise.all([
      query<FleetRow>(
        `SELECT d.id AS site_device_id,d.public_id,d.business_id,b.name AS business_name,
                d.location_id,l.name AS location_name,d.display_name,d.status AS device_status,
                d.revoked_at,d.last_seen_at,rs.app_version,rs.commit_sha,rs.build_id,
                rs.schema_version,rs.electron_version,rs.platform,rs.release_channel,
                rs.client_checked_at,rs.reported_at,rs.update_state,rs.update_target_version,
                rs.last_error_code,rs.last_error_message,
                runs.last_push_at,runs.last_pull_at,COALESCE(events.update_events,'[]'::jsonb) AS update_events
           FROM site_devices d
           JOIN businesses b ON b.id=d.business_id
           JOIN locations l ON l.id=d.location_id AND l.business_id=d.business_id
           LEFT JOIN site_device_runtime_status rs ON rs.site_device_id=d.id
           LEFT JOIN LATERAL (
             SELECT max(started_at) FILTER (WHERE direction='push' AND status='ok') AS last_push_at,
                    max(started_at) FILTER (WHERE direction='pull' AND status='ok') AS last_pull_at
               FROM sync_runs sr
              WHERE sr.site_device_id=d.id AND sr.business_id=d.business_id
           ) runs ON true
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                      'state',event.state,
                      'installedVersion',event.installed_version,
                      'targetVersion',event.target_version,
                      'errorCode',event.error_code,
                      'clientOccurredAt',event.client_occurred_at,
                      'reportedAt',event.reported_at
                    ) ORDER BY event.reported_at DESC) AS update_events
               FROM (
                 SELECT state,installed_version,target_version,error_code,client_occurred_at,reported_at
                   FROM site_device_update_events due
                  WHERE due.site_device_id=d.id AND due.business_id=d.business_id
                  ORDER BY reported_at DESC
                  LIMIT 12
               ) event
           ) events ON true
          ORDER BY b.name,l.name,d.display_name`,
      ),
      releaseRows().then((rows) => rows.map(rowToRelease)),
    ]);
    const devices = runtime.rows.map((row): FleetDeviceStatus => {
      const channel = row.release_channel ?? "stable";
      const targetRelease = selectTargetRelease(releases, channel, row.public_id);
      const connectivity = classifyDeviceConnectivity(row.reported_at, now);
      let compliance = classifyDesktopVersion(
        row.app_version,
        targetRelease?.version,
        targetRelease?.minimumSupportedVersion,
      );
      if (targetRelease && row.schema_version !== null) {
        if (
          (targetRelease.database.minimumSchemaVersion !== null && row.schema_version < targetRelease.database.minimumSchemaVersion) ||
          (targetRelease.database.maximumSchemaVersion !== null && row.schema_version > targetRelease.database.maximumSchemaVersion)
        ) compliance = "incompatible";
      }
      const hasError = Boolean(row.last_error_code) || row.device_status !== "active" || Boolean(row.revoked_at);
      compliance = complianceWithFreshness(compliance, connectivity, hasError);
      return {
        siteDeviceId: row.site_device_id,
        publicId: row.public_id,
        businessId: row.business_id,
        businessName: row.business_name,
        locationId: row.location_id,
        locationName: row.location_name,
        deviceName: row.display_name,
        deviceStatus: row.device_status,
        revoked: Boolean(row.revoked_at),
        installedVersion: row.app_version,
        buildCommit: row.commit_sha,
        buildId: row.build_id,
        schemaVersion: row.schema_version,
        electronVersion: row.electron_version,
        platform: row.platform,
        channel,
        targetRelease,
        compliance,
        connectivity,
        lastSeenAt: maybeIso(row.last_seen_at),
        lastReportAt: maybeIso(row.reported_at),
        clientCheckedAt: maybeIso(row.client_checked_at),
        lastSuccessfulPushAt: maybeIso(row.last_push_at),
        lastSuccessfulPullAt: maybeIso(row.last_pull_at),
        updateState: row.update_state,
        updateTargetVersion: row.update_target_version,
        error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
        updateEvents: row.update_events.map((event) => ({
          ...event,
          clientOccurredAt: event.clientOccurredAt ? iso(event.clientOccurredAt) : null,
          reportedAt: iso(event.reportedAt),
        })),
      };
    });
    return {
      devices,
      releases,
      summary: {
        installations: devices.length,
        upToDate: devices.filter((device) => device.compliance === "up_to_date").length,
        updateAvailable: devices.filter((device) => device.compliance === "update_available").length,
        offline: devices.filter((device) => device.compliance === "offline").length,
        problems: devices.filter((device) => ["error", "unsupported", "incompatible", "version_mismatch", "stale"].includes(device.compliance)).length,
      },
    };
  });
}

export interface SaveDesktopReleaseInput {
  version: string;
  buildCommit: string;
  buildId: string;
  channel: DesktopReleaseChannel;
  status: ReleaseLifecycleStatus;
  rolloutState: ReleaseRolloutState;
  rolloutPercentage: number;
  minimumSupportedVersion: string | null;
  mandatory: boolean;
  installerUrl: string;
  installerSha256: string;
  installerSize: number;
  manifestSignature: string;
  expectedPublisher: string;
  migrationVersion: number | null;
  minimumSchemaVersion: number | null;
  maximumSchemaVersion: number | null;
  releaseNotes: string[];
  recoveryNotes: string | null;
  knownGoodReleaseId: string | null;
}

function releaseInputAsManifest(input: SaveDesktopReleaseInput): DesktopReleaseManifest {
  return {
    manifestSignature: input.manifestSignature,
    version: input.version,
    buildCommit: input.buildCommit,
    buildId: input.buildId,
    channel: input.channel,
    releasedAt: new Date(0).toISOString(),
    minimumSupportedVersion: input.minimumSupportedVersion,
    mandatory: input.mandatory,
    installer: {
      url: input.installerUrl,
      sha256: input.installerSha256,
      size: input.installerSize,
      signatureRequired: true,
      expectedPublisher: input.expectedPublisher,
    },
    database: {
      migrationVersion: input.migrationVersion,
      minimumSchemaVersion: input.minimumSchemaVersion,
      maximumSchemaVersion: input.maximumSchemaVersion,
      backupRequired: true,
    },
    releaseNotes: input.releaseNotes,
    recovery: { knownGoodVersion: null, notes: input.recoveryNotes },
  };
}

function releaseManifestSignatureValid(input: SaveDesktopReleaseInput): boolean | null {
  const configured = process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n").trim();
  if (!configured) return null;
  try {
    return verifySignature(
      "sha256",
      Buffer.from(canonicalDesktopManifestPayload(releaseInputAsManifest(input))),
      createPublicKey(configured),
      Buffer.from(input.manifestSignature, "base64"),
    );
  } catch {
    return false;
  }
}

export function validateDesktopReleaseInput(value: unknown):
  | { ok: true; input: SaveDesktopReleaseInput }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "bad_request" };
  const body = value as Record<string, unknown>;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!parseSemVer(version)) return { ok: false, error: "invalid_version" };
  if (!isDesktopReleaseChannel(body.channel)) return { ok: false, error: "invalid_channel" };
  if (!(["draft", "published", "paused", "withdrawn"] as unknown[]).includes(body.status)) {
    return { ok: false, error: "invalid_status" };
  }
  if (!(["internal", "pilot", "percentage", "full", "paused"] as unknown[]).includes(body.rolloutState)) {
    return { ok: false, error: "invalid_rollout" };
  }
  const rolloutState = body.rolloutState as ReleaseRolloutState;
  const rolloutPercentage = rolloutState === "full" ? 100 : rolloutState === "pilot" || rolloutState === "percentage"
    ? Number(body.rolloutPercentage) : 0;
  if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100 ||
      (rolloutState === "pilot" && (rolloutPercentage < 1 || rolloutPercentage > 20)) ||
      (rolloutState === "percentage" && (rolloutPercentage < 1 || rolloutPercentage > 99))) {
    return { ok: false, error: "invalid_rollout_percentage" };
  }
  let installerUrl: URL;
  try { installerUrl = new URL(typeof body.installerUrl === "string" ? body.installerUrl : ""); }
  catch { return { ok: false, error: "invalid_installer_url" }; }
  if (installerUrl.protocol !== "https:") return { ok: false, error: "invalid_installer_url" };
  const installerSha256 = typeof body.installerSha256 === "string" ? body.installerSha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(installerSha256)) return { ok: false, error: "invalid_installer_sha256" };
  const installerSize = Number(body.installerSize);
  if (!Number.isSafeInteger(installerSize) || installerSize < 1) return { ok: false, error: "invalid_installer_size" };
  const buildCommit = typeof body.buildCommit === "string" ? body.buildCommit.trim() : "";
  if (!/^[0-9a-f]{7,64}$/i.test(buildCommit)) return { ok: false, error: "invalid_build_commit" };
  const buildId = typeof body.buildId === "string" ? body.buildId.trim() : "";
  if (!buildId || buildId.length > 200) return { ok: false, error: "invalid_build_id" };
  const minimumSupportedVersion = typeof body.minimumSupportedVersion === "string" && body.minimumSupportedVersion.trim()
    ? body.minimumSupportedVersion.trim() : null;
  if (minimumSupportedVersion && !parseSemVer(minimumSupportedVersion)) return { ok: false, error: "invalid_minimum_version" };
  const nullableInteger = (entry: unknown): number | null => {
    if (entry === null || entry === undefined || entry === "") return null;
    const number = Number(entry);
    return Number.isSafeInteger(number) && number > 0 ? number : Number.NaN;
  };
  const migrationVersion = nullableInteger(body.migrationVersion);
  const minimumSchemaVersion = nullableInteger(body.minimumSchemaVersion);
  const maximumSchemaVersion = nullableInteger(body.maximumSchemaVersion);
  if ([migrationVersion, minimumSchemaVersion, maximumSchemaVersion].some(Number.isNaN)) {
    return { ok: false, error: "invalid_schema_version" };
  }
  if (minimumSchemaVersion && maximumSchemaVersion && maximumSchemaVersion < minimumSchemaVersion) {
    return { ok: false, error: "invalid_schema_range" };
  }
  const expectedPublisher = optionalText(body.expectedPublisher, 240);
  if (!expectedPublisher) return { ok: false, error: "invalid_expected_publisher" };
  const notes = Array.isArray(body.releaseNotes)
    ? body.releaseNotes.filter((note): note is string => typeof note === "string").map((note) => note.trim()).filter(Boolean)
    : [];
  const knownGoodReleaseId = optionalText(body.knownGoodReleaseId, 80);
  if (knownGoodReleaseId && !isUuid(knownGoodReleaseId)) return { ok: false, error: "invalid_known_good_release" };
  const manifestSignature = optionalText(body.manifestSignature, 4_000);
  if (!manifestSignature || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(manifestSignature)) {
    return { ok: false, error: "invalid_manifest_signature" };
  }
  const input: SaveDesktopReleaseInput = {
    version, buildCommit, buildId, channel: body.channel,
    status: body.status as ReleaseLifecycleStatus,
    rolloutState, rolloutPercentage,
    minimumSupportedVersion, mandatory: body.mandatory === true,
    installerUrl: installerUrl.toString(), installerSha256, installerSize,
    manifestSignature, expectedPublisher,
    migrationVersion, minimumSchemaVersion, maximumSchemaVersion,
    releaseNotes: notes.slice(0, 100), recoveryNotes: optionalText(body.recoveryNotes, 4_000),
    knownGoodReleaseId,
  };
  const validSignature = releaseManifestSignatureValid(input);
  if (validSignature === false) return { ok: false, error: "invalid_manifest_signature" };
  if (validSignature === null && process.env.NODE_ENV === "production") {
    return { ok: false, error: "manifest_public_key_not_configured" };
  }
  return { ok: true, input };
}

export async function createDesktopRelease(input: SaveDesktopReleaseInput, adminId: string | null): Promise<PlatformDesktopRelease> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO platform_releases
         (version,build_commit,build_id,channel,status,rollout_state,rollout_percentage,
          released_at,minimum_supported_version,mandatory,installer_url,installer_sha256,
          installer_size,manifest_signature,signature_required,expected_publisher,migration_version,
          minimum_schema_version,maximum_schema_version,backup_required,release_notes,
          recovery_notes,known_good_release_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='draft' THEN NULL ELSE now() END,
               $8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17,true,$18,$19,$20,$21)
       RETURNING id`,
      [input.version,input.buildCommit,input.buildId,input.channel,input.status,input.rolloutState,
        input.rolloutPercentage,input.minimumSupportedVersion,input.mandatory,input.installerUrl,
        input.installerSha256,input.installerSize,input.manifestSignature,input.expectedPublisher,input.migrationVersion,
        input.minimumSchemaVersion,input.maximumSchemaVersion,JSON.stringify(input.releaseNotes),
        input.recoveryNotes,input.knownGoodReleaseId,adminId],
    );
    const release = (await releaseRows()).find((item) => item.id === rows[0].id);
    if (!release) throw new Error("release_create_failed");
    return rowToRelease(release);
  });
}

export async function updateDesktopReleaseRollout(
  releaseId: string,
  update: { status: ReleaseLifecycleStatus; rolloutState: ReleaseRolloutState; rolloutPercentage: number },
): Promise<PlatformDesktopRelease | null> {
  return withoutTenantScope("platform", async () => {
    await query(
      `UPDATE platform_releases SET status=$2,rollout_state=$3,rollout_percentage=$4,
              released_at=CASE WHEN $2='draft' THEN NULL ELSE COALESCE(released_at,now()) END,updated_at=now()
        WHERE id=$1`,
      [releaseId, update.status, update.rolloutState, update.rolloutPercentage],
    );
    const release = (await releaseRows()).find((item) => item.id === releaseId);
    return release ? rowToRelease(release) : null;
  });
}
