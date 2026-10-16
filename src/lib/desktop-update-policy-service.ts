/**
 * Database half of the Desktop update policy (migration 0227). Reads resolve
 * the layers that apply to ONE authenticated device; writes are Superadmin
 * only and are always scope-checked against the business that owns the target,
 * so a location or device id from another business can never be named.
 */
import { query, withoutTenantScope } from "./db";
import {
  buildPolicyDocument,
  effectivePolicyChannel,
  resolveDesktopUpdatePolicy,
  validateDesktopUpdatePolicyPatch,
  POLICY_KEYS,
  type DesktopUpdatePolicyDocument,
  type DesktopUpdatePolicyPatch,
  type PolicyLayer,
  type PolicyScope,
  type ResolvedPolicy,
} from "./desktop-update-policy";
import { selectTargetReleaseForPolicy, type PlatformDesktopRelease } from "./desktop-release-service";
import type { DesktopReleaseChannel } from "./desktop-release";

interface PlatformPolicyRow extends Record<string, unknown> {
  policy: DesktopUpdatePolicyPatch;
  version: string | number;
  reason: string | null;
  updated_at: Date | string;
}

interface BusinessPolicyRow extends Record<string, unknown> {
  id: string;
  scope: Exclude<PolicyScope, "platform">;
  location_id: string | null;
  site_device_id: string | null;
  policy: DesktopUpdatePolicyPatch;
  version: string | number;
  reason: string | null;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Stored patches are re-validated on read: a hand-edited row must not widen authority. */
function storedPatch(value: unknown): DesktopUpdatePolicyPatch {
  const checked = validateDesktopUpdatePolicyPatch(value);
  return checked.ok ? checked.patch : {};
}

export interface DevicePolicyIdentity {
  businessId: string;
  locationId: string;
  siteDeviceId: string;
}

/**
 * Layers applicable to one device. Runs in the device's tenant scope (the
 * business layers are RLS-protected; the platform singleton is exempt).
 */
export async function loadDevicePolicyLayers(identity: DevicePolicyIdentity): Promise<PolicyLayer[]> {
  const [platform, business] = await Promise.all([
    query<PlatformPolicyRow>(
      `SELECT policy,version,reason,updated_at FROM platform_desktop_update_policy WHERE id`,
    ),
    query<BusinessPolicyRow>(
      `SELECT id,scope,location_id,site_device_id,policy,version,reason,updated_at
         FROM business_desktop_update_policies
        WHERE business_id=$1
          AND (scope='business'
               OR (scope='location' AND location_id=$2)
               OR (scope='device' AND site_device_id=$3))`,
      [identity.businessId, identity.locationId, identity.siteDeviceId],
    ),
  ]);
  const layers: PolicyLayer[] = [];
  const base = platform.rows[0];
  if (base) {
    layers.push({
      scope: "platform", patch: storedPatch(base.policy), version: Number(base.version),
      reason: base.reason, updatedAt: iso(base.updated_at),
    });
  }
  for (const row of business.rows) {
    layers.push({
      scope: row.scope, patch: storedPatch(row.policy), version: Number(row.version),
      reason: row.reason, updatedAt: iso(row.updated_at),
    });
  }
  return layers;
}

export interface DeviceUpdateDecision {
  document: DesktopUpdatePolicyDocument;
  resolved: ResolvedPolicy;
  targetRelease: PlatformDesktopRelease | null;
  /** Why no target was handed over, when none was. */
  withheldReason: "hold" | "pinned_release_unavailable" | "no_eligible_release" | null;
}

/**
 * Resolves the effective policy and the release this device may be offered.
 * Eligibility is decided here, before a target or policy leaves Central; the
 * device is never asked what it is allowed to install.
 */
export function decideDeviceUpdate(input: {
  identity: DevicePolicyIdentity & { publicDeviceId: string };
  layers: PolicyLayer[];
  releases: PlatformDesktopRelease[];
  reportedChannel: DesktopReleaseChannel;
  now: Date;
}): DeviceUpdateDecision {
  const resolved = resolveDesktopUpdatePolicy(input.layers);
  const { policy } = resolved;
  const pinned = policy.targetReleaseId
    ? input.releases.find((release) => release.id === policy.targetReleaseId) ?? null
    : null;
  const channel = effectivePolicyChannel(policy, pinned?.channel ?? null, input.reportedChannel);
  const selection = selectTargetReleaseForPolicy(input.releases, {
    channel,
    targetReleaseId: policy.targetReleaseId,
    hold: policy.hold,
    publicDeviceId: input.identity.publicDeviceId,
  });
  return {
    document: buildPolicyDocument({
      resolved, businessId: input.identity.businessId, deviceId: input.identity.publicDeviceId,
      channel, now: input.now,
    }),
    resolved,
    targetRelease: selection.release,
    withheldReason: selection.withheldReason,
  };
}

/** Delivery bookkeeping: what Central handed over and what the device says it applied. */
export async function recordPolicyDelivery(
  identity: DevicePolicyIdentity,
  deliveredVersion: number,
  acknowledgedVersion: number | null,
): Promise<void> {
  await query(
    `UPDATE site_device_runtime_status
        SET delivered_policy_version=GREATEST(COALESCE(delivered_policy_version,0),$3),
            delivered_policy_at=now(),
            acknowledged_policy_version=CASE
              WHEN $4::bigint IS NULL THEN acknowledged_policy_version
              ELSE GREATEST(COALESCE(acknowledged_policy_version,0),$4::bigint) END,
            acknowledged_policy_at=CASE
              WHEN $4::bigint IS NULL OR $4::bigint <= COALESCE(acknowledged_policy_version,-1)
              THEN acknowledged_policy_at ELSE now() END
      WHERE site_device_id=$1 AND business_id=$2`,
    [identity.siteDeviceId, identity.businessId, deliveredVersion, acknowledgedVersion],
  );
}

// ---------------------------------------------------------------------------
// Superadmin side
// ---------------------------------------------------------------------------

export type PolicyTarget =
  | { scope: "platform" }
  | { scope: "business"; businessId: string }
  | { scope: "location"; businessId: string; locationId: string }
  | { scope: "device"; businessId: string; siteDeviceId: string };

export interface PolicyWriteInput {
  target: PolicyTarget;
  set: DesktopUpdatePolicyPatch;
  clear: string[];
  reason: string;
  adminId: string;
  /** Optimistic lock: refuse when the layer moved since the operator read it. */
  expectedVersion: number | null;
}

export type PolicyWriteResult =
  | { ok: true; layer: PolicyLayer; before: DesktopUpdatePolicyPatch }
  | { ok: false; error: "target_not_found" | "version_conflict" | "unknown_policy_key" };

async function targetBelongsToBusiness(target: PolicyTarget): Promise<boolean> {
  if (target.scope === "platform") return true;
  if (target.scope === "business") {
    const { rows } = await query(`SELECT 1 FROM businesses WHERE id=$1`, [target.businessId]);
    return rows.length > 0;
  }
  if (target.scope === "location") {
    const { rows } = await query(`SELECT 1 FROM locations WHERE id=$1 AND business_id=$2`, [target.locationId, target.businessId]);
    return rows.length > 0;
  }
  const { rows } = await query(`SELECT 1 FROM site_devices WHERE id=$1 AND business_id=$2`, [target.siteDeviceId, target.businessId]);
  return rows.length > 0;
}

/** Superadmin write. The caller has already passed `updates.manage` and audits the result. */
export async function writeDesktopUpdatePolicy(input: PolicyWriteInput): Promise<PolicyWriteResult> {
  if (input.clear.some((key) => !(POLICY_KEYS as readonly string[]).includes(key))) {
    return { ok: false, error: "unknown_policy_key" };
  }
  return withoutTenantScope("platform", async () => {
    if (!(await targetBelongsToBusiness(input.target))) return { ok: false, error: "target_not_found" } as const;
    const { target } = input;
    const existing = target.scope === "platform"
      ? (await query<PlatformPolicyRow>(
          `SELECT policy,version,reason,updated_at FROM platform_desktop_update_policy WHERE id FOR UPDATE`,
        )).rows[0]
      : (await query<BusinessPolicyRow>(
          target.scope === "business"
            ? `SELECT id,scope,location_id,site_device_id,policy,version,reason,updated_at
                 FROM business_desktop_update_policies WHERE business_id=$1 AND scope='business' FOR UPDATE`
            : target.scope === "location"
              ? `SELECT id,scope,location_id,site_device_id,policy,version,reason,updated_at
                   FROM business_desktop_update_policies WHERE business_id=$1 AND scope='location' AND location_id=$2 FOR UPDATE`
              : `SELECT id,scope,location_id,site_device_id,policy,version,reason,updated_at
                   FROM business_desktop_update_policies WHERE business_id=$1 AND scope='device' AND site_device_id=$2 FOR UPDATE`,
          target.scope === "business" ? [target.businessId]
            : target.scope === "location" ? [target.businessId, target.locationId]
              : [target.businessId, target.siteDeviceId],
        )).rows[0];
    const currentVersion = existing ? Number(existing.version) : 0;
    if (input.expectedVersion !== null && input.expectedVersion !== currentVersion) {
      return { ok: false, error: "version_conflict" } as const;
    }
    const before = existing ? storedPatch(existing.policy) : {};
    const next: Record<string, unknown> = { ...before, ...input.set };
    for (const key of input.clear) delete next[key];
    const { rows: seq } = await query<{ version: string }>(`SELECT nextval('desktop_update_policy_seq') AS version`);
    const version = Number(seq[0].version);
    let updatedAt: Date | string;
    if (target.scope === "platform") {
      const { rows } = await query<{ updated_at: Date | string }>(
        `UPDATE platform_desktop_update_policy
            SET policy=$1,version=$2,reason=$3,updated_by=$4,updated_at=now()
          WHERE id RETURNING updated_at`,
        [JSON.stringify(next), version, input.reason, input.adminId],
      );
      updatedAt = rows[0].updated_at;
    } else if (existing) {
      const { rows } = await query<{ updated_at: Date | string }>(
        `UPDATE business_desktop_update_policies
            SET policy=$2,version=$3,reason=$4,updated_by=$5,updated_at=now()
          WHERE id=$1 RETURNING updated_at`,
        [(existing as BusinessPolicyRow).id, JSON.stringify(next), version, input.reason, input.adminId],
      );
      updatedAt = rows[0].updated_at;
    } else {
      const { rows } = await query<{ updated_at: Date | string }>(
        `INSERT INTO business_desktop_update_policies
           (business_id,scope,location_id,site_device_id,policy,version,reason,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING updated_at`,
        [target.businessId, target.scope,
          target.scope === "location" ? target.locationId : null,
          target.scope === "device" ? target.siteDeviceId : null,
          JSON.stringify(next), version, input.reason, input.adminId],
      );
      updatedAt = rows[0].updated_at;
    }
    return {
      ok: true,
      before,
      layer: {
        scope: target.scope, patch: storedPatch(next), version, reason: input.reason, updatedAt: iso(updatedAt),
      },
    } as const;
  });
}

export interface BusinessPolicyOverview {
  platform: PolicyLayer;
  layers: Array<PolicyLayer & { locationId: string | null; siteDeviceId: string | null }>;
}

/** Everything the console's policy editor needs for one business. */
export async function readBusinessPolicyOverview(businessId: string): Promise<BusinessPolicyOverview | null> {
  return withoutTenantScope("platform", async () => {
    const exists = await query(`SELECT 1 FROM businesses WHERE id=$1`, [businessId]);
    if (exists.rows.length === 0) return null;
    const platform = (await query<PlatformPolicyRow>(
      `SELECT policy,version,reason,updated_at FROM platform_desktop_update_policy WHERE id`,
    )).rows[0];
    const { rows } = await query<BusinessPolicyRow>(
      `SELECT id,scope,location_id,site_device_id,policy,version,reason,updated_at
         FROM business_desktop_update_policies WHERE business_id=$1 ORDER BY scope,updated_at DESC`,
      [businessId],
    );
    return {
      platform: {
        scope: "platform", patch: storedPatch(platform?.policy), version: Number(platform?.version ?? 0),
        reason: platform?.reason ?? null, updatedAt: platform ? iso(platform.updated_at) : null,
      },
      layers: rows.map((row) => ({
        scope: row.scope, patch: storedPatch(row.policy), version: Number(row.version), reason: row.reason,
        updatedAt: iso(row.updated_at), locationId: row.location_id, siteDeviceId: row.site_device_id,
      })),
    };
  });
}

/** Resolved-policy preview for one device, as the device itself would receive it. */
export async function previewDevicePolicy(siteDeviceId: string, releases: PlatformDesktopRelease[], now = new Date()) {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      business_id: string; location_id: string; public_id: string; release_channel: DesktopReleaseChannel | null;
    }>(
      `SELECT d.business_id,d.location_id,d.public_id,rs.release_channel
         FROM site_devices d LEFT JOIN site_device_runtime_status rs ON rs.site_device_id=d.id
        WHERE d.id=$1`,
      [siteDeviceId],
    );
    const device = rows[0];
    if (!device) return null;
    const identity = { businessId: device.business_id, locationId: device.location_id, siteDeviceId };
    const layers = await loadDevicePolicyLayers(identity);
    return decideDeviceUpdate({
      identity: { ...identity, publicDeviceId: device.public_id },
      layers, releases, reportedChannel: device.release_channel ?? "stable", now,
    });
  });
}
