import { NextRequest,NextResponse } from "next/server";
import { requirePermission,withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting,SETTING_KEYS } from "@/lib/settings";
import type { ServerSyncConfig } from "@/lib/server-sync-config";
import { getServerSyncState } from "@/lib/server-sync";
import { runIamSync } from "@/lib/iam/sync";
import { readHybridIdentityStatus, syncHybridLoginCredentials } from "@/lib/iam/login-credential-sync";
import { clearOperationalSyncBlock, readOperationalSyncBlockState } from "@/lib/iam/operational-sync-block";
import { operationalSyncHealth } from "@/lib/iam/operational-sync-health";

/**
 * IAM status/repair, split into the two planes the fix for the owner-only
 * roster depends on:
 *
 *  - identity — memberships/roles, as `iam_sync_state` records them;
 *  - credentials — the login-credential stage (`iam_login_credential_sync_state`),
 *    which is where cloud-made staff PINs and replicated passwords arrive;
 *  - operational — master data / push / pull, reported as timestamps only.
 *
 * The overall verdict is computed by `hybridIdentityHealth()`, so a healthy
 * membership snapshot can never make a site with missing PIN credentials read
 * as fully healthy.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.teamView);
  if (guard.error) return guard.error;
  const businessId = guard.session.businessId;
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  const [identity, health, operational, block] = await Promise.all([
    config?.siteDeviceId
      ? query<{
          last_sequence: string; last_attempt_at: Date | null; last_success_at: Date | null;
          status: string; last_error: string | null; pending: string; failed: string;
        }>(
          `SELECT s.last_sequence,s.last_attempt_at,s.last_success_at,s.status,s.last_error,
             (SELECT count(*) FROM iam_commands c WHERE c.business_id=s.business_id AND c.site_device_id=s.site_device_id AND c.status='pending')::text pending,
             (SELECT count(*) FROM iam_dead_letters d WHERE d.business_id=s.business_id AND d.site_device_id=s.site_device_id AND d.status='open')::text failed
           FROM iam_sync_state s WHERE s.business_id=$1 AND s.site_device_id=$2`,
          [businessId, config.siteDeviceId],
        )
      : Promise.resolve({ rows: [] as never[] }),
    readHybridIdentityStatus(businessId, { config }),
    getServerSyncState(businessId),
    // Issue #988 — the operational plane's own evidence: whether the security
    // gate is holding this site's master data, push and pull back right now.
    config?.siteDeviceId
      ? readOperationalSyncBlockState(businessId, config.siteDeviceId)
      : Promise.resolve(null),
  ]);
  const row = identity.rows[0];
  const operationalPlane = operationalSyncHealth({
    configured: Boolean(config?.enabled && config.siteDeviceId),
    block,
  });
  return NextResponse.json({
    // Backwards-compatible membership view (existing callers read `status`).
    status: row
      ? {
          sequence: Number(row.last_sequence),
          state: row.status,
          lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          lastError: row.last_error,
          pending: Number(row.pending),
          failed: Number(row.failed),
        }
      : { state: "snapshot_required", sequence: 0, pending: 0, failed: 0 },
    identity: {
      state: row?.status ?? (health.configured ? "snapshot_required" : "not_configured"),
      lastAttemptAt: row?.last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
      lastError: row?.last_error ?? null,
      pending: row ? Number(row.pending) : 0,
      failed: row ? Number(row.failed) : 0,
    },
    credentials: health.configured
      ? {
          state: health.credentials?.status ?? "pending",
          lastAttemptAt: health.credentials?.lastAttemptAt ?? null,
          lastSuccessAt: health.credentials?.lastSuccessAt ?? null,
          lastError: health.credentials?.lastError ?? null,
          membershipsExpected: health.memberships.expected,
          identitiesExpected: health.memberships.passwordRoles,
          identitiesLinked: health.memberships.linkedIdentities,
          credentialsReceived: health.credentials?.credentialsReceived ?? 0,
          pinsReceived: health.credentials?.pinsReceived ?? 0,
          pinsApplied: health.credentials?.pinsApplied ?? 0,
          pinsRevoked: health.credentials?.pinsRevoked ?? 0,
          identitiesApplied: health.credentials?.identitiesApplied ?? 0,
          pinMembersExpected: health.pinGap.expected,
          pinMembersUsable: health.pinGap.usable,
          pinMembersMissing: health.pinGap.missing,
          // Names and roles of the members the quick-login roster omits —
          // never a credential.
          missingPinMembers: health.pinGap.missingMembers,
          missingIdentityBindings: health.missingIdentityBindings,
          // Issue #948 — binding evidence, separate from "hashes match":
          // what the last pass repaired/re-keyed, and which contract the
          // cloud's payload spoke.
          identityMismatches: health.credentials?.identityMismatches ?? 0,
          identitiesRekeyed: health.credentials?.identityRekeys ?? 0,
          identityContract: health.credentials?.identityContract ?? null,
          convergedAt: health.credentials?.convergedAt ?? null,
        }
      : { state: "not_configured" },
    operational: {
      // Issue #988 — a gated tick leaves no push/pull error of its own, so the
      // operational plane is read from its durable record first: `attention_required`
      // here means "the security plane is holding this site's traffic back",
      // which `paused` (a refused or unreachable sync call) does not.
      state: operationalPlane.state === "blocked"
        ? "attention_required"
        : !config?.enabled
          ? "not_configured"
          : operational.lastPushError || operational.lastPullError
            ? "paused"
            : operational.lastPullSuccessAt
              ? "connected"
              : "connecting",
      lastPushSuccessAt: operational.lastPushSuccessAt,
      lastPullSuccessAt: operational.lastPullSuccessAt,
      lastError: operational.lastPushError || operational.lastPullError || null,
      blocked: operationalPlane.state === "blocked",
      consecutiveBlockedTicks: operationalPlane.consecutiveBlockedTicks,
      /** Past OPERATIONAL_SYNC_ALERT_AFTER_TICKS — a block worth escalating. */
      alertDue: operationalPlane.alertDue,
      blockedSince: block?.firstBlockedAt ?? null,
      lastBlockedAt: block?.lastBlockedAt ?? null,
      lastRecoveredAt: block?.lastRecoveredAt ?? null,
      blockError: block?.lastError ?? null,
      blockCode: operationalPlane.code,
      /** Local events the gate is holding back, as counted at the last blocked tick. */
      pendingOutbox: block?.pendingOutbox ?? 0,
      episodesBlocked: block?.episodesBlocked ?? 0,
    },
    overall: health.overall,
    degradedBy: health.degradedBy,
    reason: health.reason,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.teamManage);
  if (guard.error) return guard.error;
  const businessId = guard.session.businessId;
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = body.action ?? "";
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.siteDeviceId) return NextResponse.json({ error: "site_not_configured" }, { status: 409 });
  if (!["sync", "repair", "retry"].includes(action)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Repair: canonical snapshot first, then events, then the login-credential
  // plane. A repair that leaves cloud PIN staff unable to sign in must not
  // report success, so the credential stage runs explicitly here (runIamSync
  // already performs it, but this call is also the verification pass) and the
  // final verdict is the combined identity/credential health.
  if (action === "repair") {
    await query(
      `UPDATE iam_sync_state SET status='snapshot_required',last_error='manual_snapshot_repair'
        WHERE business_id=$1 AND site_device_id=$2`,
      [businessId, config.siteDeviceId],
    );
  }
  const identitySyncOk = await runIamSync(businessId);
  /*
   * Issue #988 — a converged manual run also lifts the *operational* gate on
   * record. The sync tick would clear it within 30 s anyway, but the operator
   * standing in front of this panel just pressed «همگام‌سازی دوباره» to fix a
   * blocked install, and leaving the row blocked would tell them the repair
   * did not work. A failed run leaves the record alone: the block is real.
   */
  if (identitySyncOk) await clearOperationalSyncBlock(businessId, config.siteDeviceId);
  const credentialSync = await syncHybridLoginCredentials(businessId, { config });
  const health = await readHybridIdentityStatus(businessId, { config });
  // Issue #948 P1-6 — "healthy" after a repair means the canonical global
  // identity mapping is in place, not merely that credential hashes match or
  // the staff PIN gap is zero. `overall === "healthy"` already refuses to be
  // green while bindings the payload named are unbound; the explicit gates
  // stay here so a caller can tell which one failed.
  const identityMismatches = health.credentials?.identityMismatches ?? 0;
  const ok = identitySyncOk
    && health.overall === "healthy"
    && health.pinGap.missing === 0
    && identityMismatches === 0;
  return NextResponse.json(
    {
      ok,
      identitySyncOk,
      credentialsConverged:
        health.pinGap.missing === 0
        && identityMismatches === 0
        && health.credentials?.status !== "degraded",
      overall: health.overall,
      degradedBy: health.degradedBy,
      reason: health.reason,
      credentialSync: {
        status: credentialSync.status,
        error: credentialSync.error,
        pinsApplied: credentialSync.pinsApplied,
        pinsRevoked: credentialSync.pinsRevoked,
        identitiesApplied: credentialSync.identitiesApplied,
        pinMembersExpected: credentialSync.pinMembersExpected,
        pinMembersUsable: credentialSync.pinMembersUsable,
        pinMembersMissing: credentialSync.pinMembersMissing,
        missingIdentityBindings: credentialSync.missingIdentityBindings,
        identityMismatches: credentialSync.identityMismatches,
        identitiesRekeyed: credentialSync.identitiesRekeyed,
        identityContract: credentialSync.identityContract,
      },
    },
    { status: ok ? 200 : 503 },
  );
});
