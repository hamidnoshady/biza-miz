/**
 * Canonical Desktop release identity and framework-free SemVer decisions.
 *
 * A Git SHA is provenance; it is never ordered as a release version.  Keeping
 * this module free of Node/React dependencies lets the server telemetry path,
 * platform console and Electron-side tests share the exact same vocabulary.
 */

export const DESKTOP_RELEASE_CHANNELS = ["stable", "beta", "internal"] as const;
export type DesktopReleaseChannel = (typeof DESKTOP_RELEASE_CHANNELS)[number];

/** The application identity a v2 manifest is bound to. */
export const DESKTOP_RELEASE_APP_ID = "bizamiz-desktop";
/** Schema 1 = RSA-SHA256 + required Authenticode. Schema 2 = versioned trust. */
export const DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const DESKTOP_MANIFEST_ALGORITHMS = ["ed25519", "rsa-sha256"] as const;
export type DesktopManifestAlgorithm = (typeof DESKTOP_MANIFEST_ALGORITHMS)[number];
export const DESKTOP_RELEASE_PLATFORMS = ["win32"] as const;
export const DESKTOP_RELEASE_ARCHITECTURES = ["x64", "arm64", "ia32"] as const;


export const DEVICE_COMPLIANCE_STATUSES = [
  "up_to_date",
  "update_available",
  "ahead_of_target",
  "version_mismatch",
  "unknown",
  "stale",
  "offline",
  "error",
  "unsupported",
  "incompatible",
] as const;
export type DeviceComplianceStatus = (typeof DEVICE_COMPLIANCE_STATUSES)[number];

export const DESKTOP_UPDATE_STATES = [
  "checking",
  "no_update",
  "update_available",
  "downloading",
  "paused",
  "verifying",
  "ready_to_install",
  "backup_in_progress",
  "installing",
  "restarting",
  "verifying_health",
  "success",
  "failed",
  "recovery_required",
] as const;
export type DesktopUpdateState = (typeof DESKTOP_UPDATE_STATES)[number];

export interface DesktopReleaseIdentity {
  version: string;
  buildCommit: string;
  buildId: string;
  channel: DesktopReleaseChannel;
}

export interface DesktopReleaseManifest extends DesktopReleaseIdentity {
  id?: string;
  /** 1 (legacy RSA + Authenticode) or 2 (versioned certificate-free trust). */
  schemaVersion?: 1 | 2;
  appId?: string | null;
  /**
   * Detached signature over canonicalDesktopManifestPayload().
   * Schema 1 and `rsa-sha256` use RSA-SHA256; `ed25519` is raw Ed25519.
   */
  manifestSignature: string;
  signatureAlgorithm?: DesktopManifestAlgorithm | null;
  /** Stable id of the key that signed this manifest; never an inline key. */
  signingKeyId?: string | null;
  /** Monotonic anti-rollback counter for this channel. */
  releaseSequence?: number | null;
  platform?: string | null;
  architecture?: string | null;
  releasedAt: string;
  /** Advisory freshness bound; offline imports use a long-lived package. */
  expiresAt?: string | null;
  minimumSupportedVersion: string | null;
  mandatory: boolean;
  installer: {
    url: string;
    sha256: string;
    size: number;
    /** Optional Authenticode defense-in-depth. The manifest never disables itself. */
    signatureRequired: boolean;
    expectedPublisher: string | null;
    /** SHA-1 thumbprint of the signing certificate (issue #1000 pin). */
    expectedPublisherThumbprint: string | null;
  };
  database: {
    migrationVersion: number | null;
    minimumSchemaVersion: number | null;
    maximumSchemaVersion: number | null;
    backupRequired: boolean;
  };
  releaseNotes: string[];
  recovery: {
    knownGoodVersion: string | null;
    notes: string | null;
  };
}

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemVer(value: string | null | undefined): ParsedSemVer | null {
  const match = value?.trim().match(SEMVER_RE);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** Returns -1, 0 or 1; null means at least one input is not SemVer. */
export function compareSemVer(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function isDesktopReleaseChannel(value: unknown): value is DesktopReleaseChannel {
  return typeof value === "string" && (DESKTOP_RELEASE_CHANNELS as readonly string[]).includes(value);
}

export function isDesktopUpdateState(value: unknown): value is DesktopUpdateState {
  return typeof value === "string" && (DESKTOP_UPDATE_STATES as readonly string[]).includes(value);
}

export function classifyDesktopVersion(
  installedVersion: string | null | undefined,
  targetVersion: string | null | undefined,
  minimumSupportedVersion?: string | null,
): DeviceComplianceStatus {
  if (!targetVersion) return "unknown";
  if (!installedVersion) return "unknown";
  if (!parseSemVer(installedVersion) || !parseSemVer(targetVersion)) return "version_mismatch";
  if (minimumSupportedVersion) {
    const minimum = compareSemVer(installedVersion, minimumSupportedVersion);
    if (minimum === null) return "version_mismatch";
    if (minimum < 0) return "unsupported";
  }
  const comparison = compareSemVer(installedVersion, targetVersion);
  if (comparison === null) return "version_mismatch";
  if (comparison < 0) return "update_available";
  if (comparison > 0) return "ahead_of_target";
  return "up_to_date";
}

export type DeviceConnectivity = "online" | "delayed" | "stale" | "offline";

/** Server-received time is authoritative; a client's clock cannot keep itself green. */
export function classifyDeviceConnectivity(
  reportedAt: string | Date | null | undefined,
  now: Date = new Date(),
): DeviceConnectivity {
  if (!reportedAt) return "offline";
  const time = reportedAt instanceof Date ? reportedAt.getTime() : new Date(reportedAt).getTime();
  if (!Number.isFinite(time)) return "offline";
  const ageMs = Math.max(0, now.getTime() - time);
  if (ageMs < 2 * 60_000) return "online";
  if (ageMs < 10 * 60_000) return "delayed";
  if (ageMs < 60 * 60_000) return "stale";
  return "offline";
}

export function complianceWithFreshness(
  compliance: DeviceComplianceStatus,
  connectivity: DeviceConnectivity,
  hasError: boolean,
): DeviceComplianceStatus {
  if (hasError) return "error";
  if (connectivity === "offline") return "offline";
  if (connectivity === "stale") return "stale";
  return compliance;
}

export type ManifestValidationResult =
  | { ok: true; manifest: DesktopReleaseManifest }
  | { ok: false; error: string };

/**
 * Stable bytes signed by the release pipeline and verified inside Electron.
 * Operational fields (database id, rollout, expiry of the rollout) are excluded;
 * every field that can select or execute installer bytes is included.
 *
 * Schema 1 stays byte-for-byte identical so an already signed legacy manifest
 * keeps verifying. Schema 2 binds the app identity, platform/architecture,
 * release sequence, freshness and signing key id as well.
 */
export function canonicalDesktopManifestPayload(manifest: DesktopReleaseManifest): string {
  if ((manifest.schemaVersion ?? 1) >= 2) {
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
        knownGoodVersion: manifest.recovery.knownGoodVersion,
        notes: manifest.recovery.notes,
      },
      signatureAlgorithm: manifest.signatureAlgorithm,
      signingKeyId: manifest.signingKeyId,
    });
  }
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
      // Omitted only for manifests signed before thumbprint pinning existed;
      // that keeps their signature valid without weakening new ones.
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

/** Strictly validates release metadata before any URL is handed to a downloader. */
export function validateDesktopReleaseManifest(value: unknown): ManifestValidationResult {
  if (!value || typeof value !== "object") return { ok: false, error: "manifest_invalid" };
  const input = value as Record<string, unknown>;
  const schemaVersion = input.schemaVersion === undefined ? 1 : input.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) return { ok: false, error: "manifest_schema_unsupported" };
  const installer = input.installer as Record<string, unknown> | null;
  const database = input.database as Record<string, unknown> | null;
  const recovery = input.recovery as Record<string, unknown> | null;
  if (!parseSemVer(typeof input.version === "string" ? input.version : "")) {
    return { ok: false, error: "manifest_version_invalid" };
  }
  if (!isDesktopReleaseChannel(input.channel)) return { ok: false, error: "manifest_channel_invalid" };
  if (typeof input.buildCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(input.buildCommit)) {
    return { ok: false, error: "manifest_commit_invalid" };
  }
  if (typeof input.buildId !== "string" || input.buildId.trim().length < 1 || input.buildId.length > 200) {
    return { ok: false, error: "manifest_build_invalid" };
  }
  if (typeof input.manifestSignature !== "string" || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(input.manifestSignature)) {
    return { ok: false, error: "manifest_signature_invalid" };
  }
  if (typeof input.releasedAt !== "string" || !Number.isFinite(Date.parse(input.releasedAt))) {
    return { ok: false, error: "manifest_release_time_invalid" };
  }
  if (!installer || typeof installer !== "object") return { ok: false, error: "manifest_installer_invalid" };
  let url: URL;
  try {
    url = new URL(typeof installer.url === "string" ? installer.url : "");
  } catch {
    return { ok: false, error: "manifest_installer_url_invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "manifest_installer_url_invalid" };
  if (typeof installer.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(installer.sha256)) {
    return { ok: false, error: "manifest_installer_hash_invalid" };
  }
  if (!Number.isSafeInteger(installer.size) || Number(installer.size) <= 0) {
    return { ok: false, error: "manifest_installer_size_invalid" };
  }
  if (!database || typeof database !== "object" || database.backupRequired !== true) {
    return { ok: false, error: "manifest_backup_required" };
  }
  const minimum = input.minimumSupportedVersion;
  if (minimum !== null && minimum !== undefined && (typeof minimum !== "string" || !parseSemVer(minimum))) {
    return { ok: false, error: "manifest_minimum_version_invalid" };
  }
  if (!Array.isArray(input.releaseNotes) || !input.releaseNotes.every((note) => typeof note === "string")) {
    return { ok: false, error: "manifest_release_notes_invalid" };
  }

  const common = {
    id: typeof input.id === "string" ? input.id : undefined,
    manifestSignature: input.manifestSignature,
    version: input.version as string,
    buildCommit: input.buildCommit,
    buildId: input.buildId,
    channel: input.channel,
    releasedAt: input.releasedAt,
    minimumSupportedVersion: typeof minimum === "string" ? minimum : null,
    mandatory: input.mandatory === true,
    database: {
      migrationVersion: integerOrNull(database.migrationVersion),
      minimumSchemaVersion: integerOrNull(database.minimumSchemaVersion),
      maximumSchemaVersion: integerOrNull(database.maximumSchemaVersion),
      backupRequired: true,
    },
    releaseNotes: input.releaseNotes as string[],
    recovery: {
      knownGoodVersion: typeof recovery?.knownGoodVersion === "string" ? recovery.knownGoodVersion : null,
      notes: typeof recovery?.notes === "string" ? recovery.notes : null,
    },
  };

  if (schemaVersion === 1) {
    if (installer.signatureRequired !== true) return { ok: false, error: "manifest_signature_required" };
    if (typeof installer.expectedPublisher !== "string" || !installer.expectedPublisher.trim()) {
      return { ok: false, error: "manifest_installer_publisher_invalid" };
    }
    // Issue #1000 - a release must pin the exact certificate, not only a name.
    if (installer.expectedPublisherThumbprint === undefined || installer.expectedPublisherThumbprint === null ||
        installer.expectedPublisherThumbprint === "") {
      return { ok: false, error: "manifest_installer_thumbprint_missing" };
    }
    const thumbprint = typeof installer.expectedPublisherThumbprint === "string"
      ? installer.expectedPublisherThumbprint.trim()
      : "";
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) {
      return { ok: false, error: "manifest_installer_thumbprint_invalid" };
    }
    return {
      ok: true,
      manifest: {
        ...common,
        schemaVersion: 1,
        installer: {
          url: url.toString(),
          sha256: installer.sha256,
          size: Number(installer.size),
          signatureRequired: true,
          expectedPublisher: installer.expectedPublisher.trim(),
          expectedPublisherThumbprint: thumbprint.toUpperCase(),
        },
      },
    };
  }

  if (input.appId !== DESKTOP_RELEASE_APP_ID) return { ok: false, error: "manifest_app_identity_invalid" };
  if (!DESKTOP_MANIFEST_ALGORITHMS.includes(input.signatureAlgorithm as DesktopManifestAlgorithm)) {
    return { ok: false, error: "manifest_algorithm_invalid" };
  }
  const signingKeyId = typeof input.signingKeyId === "string" ? input.signingKeyId.trim() : "";
  if (signingKeyId.length < 8 || signingKeyId.length > 200 || !/^[A-Za-z0-9:+._-]+$/.test(signingKeyId)) {
    return { ok: false, error: "manifest_signing_key_invalid" };
  }
  const releaseSequence = Number(input.releaseSequence);
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
    return { ok: false, error: "manifest_release_sequence_invalid" };
  }
  if (input.platform !== "win32") return { ok: false, error: "manifest_platform_invalid" };
  if (!DESKTOP_RELEASE_ARCHITECTURES.includes(input.architecture as (typeof DESKTOP_RELEASE_ARCHITECTURES)[number])) {
    return { ok: false, error: "manifest_architecture_invalid" };
  }
  let expiresAt: string | null = null;
  if (input.expiresAt !== null && input.expiresAt !== undefined && input.expiresAt !== "") {
    if (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt))) {
      return { ok: false, error: "manifest_expiry_invalid" };
    }
    if (Date.parse(input.expiresAt) <= Date.parse(input.releasedAt)) {
      return { ok: false, error: "manifest_expiry_invalid" };
    }
    expiresAt = new Date(input.expiresAt).toISOString();
  }
  if (typeof installer.signatureRequired !== "boolean") {
    return { ok: false, error: "manifest_signature_required_invalid" };
  }
  const signatureRequired = installer.signatureRequired;
  let expectedPublisher: string | null = null;
  let expectedPublisherThumbprint: string | null = null;
  if (signatureRequired) {
    if (typeof installer.expectedPublisher !== "string" || !installer.expectedPublisher.trim()) {
      return { ok: false, error: "manifest_installer_publisher_invalid" };
    }
    const thumbprint = typeof installer.expectedPublisherThumbprint === "string"
      ? installer.expectedPublisherThumbprint.trim()
      : "";
    if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) {
      return { ok: false, error: "manifest_installer_thumbprint_invalid" };
    }
    expectedPublisher = installer.expectedPublisher.trim();
    expectedPublisherThumbprint = thumbprint.toUpperCase();
  }
  return {
    ok: true,
    manifest: {
      ...common,
      schemaVersion: 2,
      appId: DESKTOP_RELEASE_APP_ID,
      signatureAlgorithm: input.signatureAlgorithm as DesktopManifestAlgorithm,
      signingKeyId,
      releaseSequence,
      platform: "win32",
      architecture: input.architecture as string,
      expiresAt,
      installer: {
        url: url.toString(),
        sha256: installer.sha256,
        size: Number(installer.size),
        signatureRequired,
        expectedPublisher,
        expectedPublisherThumbprint,
      },
    },
  };
}

function integerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
