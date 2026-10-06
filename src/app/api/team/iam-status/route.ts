import { NextRequest,NextResponse } from "next/server";
import { requirePermission,withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting,SETTING_KEYS } from "@/lib/settings";
import type { ServerSyncConfig } from "@/lib/server-sync-config";
import { getServerSyncState } from "@/lib/server-sync";
import { runIamSync } from "@/lib/iam/sync";
import { readHybridIdentityStatus, syncHybridLoginCredentials } from "@/lib/iam/login-credential-sync";

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
  const [identity, health, operational] = await Promise.all([
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
  ]);
  const row = identity.rows[0];
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
          convergedAt: health.credentials?.convergedAt ?? null,
        }
      : { state: "not_configured" },
    operational: {
      state: operational.lastPushError || operational.lastPullError ? "paused" : operational.lastPullSuccessAt ? "connected" : "connecting",
      lastPushSuccessAt: operational.lastPushSuccessAt,
      lastPullSuccessAt: operational.lastPullSuccessAt,
      lastError: operational.lastPushError || operational.lastPullError || null,
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
  const credentialSync = await syncHybridLoginCredentials(businessId, { config });
  const health = await readHybridIdentityStatus(businessId, { config });
  const ok = identitySyncOk && health.overall === "healthy" && health.pinGap.missing === 0;
  return NextResponse.json(
    {
      ok,
      identitySyncOk,
      credentialsConverged: health.pinGap.missing === 0 && health.credentials?.status !== "degraded",
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
      },
    },
    { status: ok ? 200 : 503 },
  );
});
