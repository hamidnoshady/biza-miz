import { NextResponse } from "next/server";
import { withTenantScope, requireMember } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { getServerSyncConfig, getServerSyncState } from "@/lib/server-sync";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { SiteProfileState } from "@/lib/site-profile";
import type {
  ConnectionStatus,
  PlatformConnectionState,
} from "@/lib/connection-state";
import {
  deliverCloudExceptions,
  pullCloudExceptionResponses,
} from "@/lib/cloud-exception-relay";
import { readHybridIdentityStatus } from "@/lib/iam/login-credential-sync";

/**
 * Authenticated, credential-free connection model shared by the global status
 * indicator and Cloud & Sync center. It deliberately answers six independent
 * questions; local-server health is never inferred from Internet health.
 */
export const dynamic = "force-dynamic";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const role = deploymentRole();
  const deployment = await readDeploymentProfile(session.businessId, role);
  const exceptionRelay =
    role === "site"
      ? await Promise.all([
          deliverCloudExceptions(session.businessId).catch(() => ({
            delivered: 0,
            pending: 0,
            configured: false,
          })),
          pullCloudExceptionResponses().catch(() => 0),
        ]).then(([outbound, received]) => ({ ...outbound, received }))
      : { delivered: 0, pending: 0, configured: false, received: 0 };
  if (role !== "site" || deployment.profile === "cloud") {
    const state: PlatformConnectionState = {
      localServer: "not_applicable",
      lanGateway: "not_applicable",
      internet: "connected",
      cloud: "connected",
      sync: "not_applicable",
      externalServices: "unknown",
      outboundPending: 0,
      inboundPending: 0,
      deferred: 0,
      conflicts: 0,
      deadLetters: 0,
      lastSuccessfulPushAt: null,
      lastSuccessfulPullAt: null,
      lastConvergedAt: null,
      lastSuccessfulSyncAt: null,
    };
    return NextResponse.json({
      profile: deployment.profile,
      ...state,
      cloudSync: "not_applicable",
      error: null,
      identitySync: null,
      credentialSync: null,
      overallIdentity: "not_configured",
      identityError: null,
      supportRelay: exceptionRelay,
    });
  }

  if (deployment.profile === "local") {
    const state: PlatformConnectionState = {
      localServer: "connected",
      lanGateway: "unknown",
      internet: "unknown",
      cloud: "not_configured",
      sync: "not_configured",
      externalServices: "not_configured",
      outboundPending: 0,
      inboundPending: 0,
      deferred: 0,
      conflicts: 0,
      deadLetters: 0,
      lastSuccessfulPushAt: null,
      lastSuccessfulPullAt: null,
      lastConvergedAt: null,
      lastSuccessfulSyncAt: null,
    };
    return NextResponse.json({
      profile: "local",
      ...state,
      cloudSync: "not_configured",
      error: null,
      identitySync: null,
      credentialSync: null,
      overallIdentity: "not_configured",
      identityError: null,
      supportRelay: exceptionRelay,
    });
  }

  const syncState = await getServerSyncState(session.businessId);
  const [config, counters] = await Promise.all([
    getServerSyncConfig(session.businessId),
    query<{
      outbound: string;
      inbound: string;
      deferred: string;
      conflicts: string;
      dead_letters: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE se.origin='local')::text AS outbound,
         count(*) FILTER (WHERE se.origin='remote' AND se.applied_at IS NULL)::text AS inbound,
         (SELECT count(*) FROM sync_domain_effects WHERE business_id=$1 AND status='deferred')::text AS deferred,
         (SELECT count(*) FROM sync_events se2 JOIN locations l2 ON l2.id=se2.location_id
            WHERE l2.business_id=$1 AND se2.error='conflict')::text AS conflicts,
         (SELECT count(*) FROM sync_event_dead_letters WHERE business_id=$1 AND status='open')::text AS dead_letters
       FROM sync_events se
       JOIN locations l ON l.id=se.location_id
       WHERE l.business_id=$1
         AND EXISTS (SELECT 1 FROM users u WHERE u.id=$3 AND u.business_id=$1 AND u.is_active)
         AND (se.origin='remote' AND se.applied_at IS NULL
              OR se.origin='local' AND se.id > $2)`,
      [session.businessId, syncStateLastPushed(syncState), session.sub],
    ),
  ]);
  const row = counters.rows[0];
  const lastSuccessfulPushAt = syncState.lastPushSuccessAt;
  const lastSuccessfulPullAt = syncState.lastPullSuccessAt;
  const lastSuccessfulSyncAt =
    [lastSuccessfulPushAt, lastSuccessfulPullAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  // A converged point needs a successful push and pull; it is bounded by the
  // older direction, not the most recent one-way contact.
  // With nothing waiting to go up, the last pull alone is a converged point
  // (an idle push contacts nobody, so its timestamp stays where it was).
  const outboundPending = Number(row?.outbound ?? 0);
  const lastConvergedAt =
    outboundPending === 0 && lastSuccessfulPullAt
      ? lastSuccessfulPullAt
      : lastSuccessfulPushAt && lastSuccessfulPullAt
        ? [lastSuccessfulPushAt, lastSuccessfulPullAt].sort()[0]
        : null;
  // The IAM reconciliation gates every operational tick (runServerSyncTick
  // skips master data, push and pull while it fails), and it records its
  // failure only in iam_sync_state. Without reading it here, a blocked site
  // had no push/pull error and no success either, and showed «در حال اتصال»
  // indefinitely instead of saying sync was stopped. Identity health alone is
  // not enough though: the login-credential plane can be broken while every
  // membership is present (the owner-only roster), so both are read and
  // reported separately, and the overall verdict may not be green while
  // required PIN credentials are missing.
  const identityStatus = config?.enabled && config.siteDeviceId
    ? await readHybridIdentityStatus(session.businessId, { config })
    : null;
  let iamError: string | null = null;
  if (identityStatus?.identity && identityStatus.identity.state !== "healthy" && identityStatus.identity.state !== "syncing") {
    iamError = `iam_sync_blocked: ${identityStatus.identity.lastError ?? identityStatus.identity.state}`;
  }
  let identityError: string | null = null;
  if (identityStatus?.configured && identityStatus.overall === "degraded") {
    // Membership metadata may be fine; the login plane is not. The connection
    // badge must not be green, but the operational pipes are still up, so this
    // rides as its own signal rather than as "cloud unreachable".
    identityError = `identity_sync_degraded: ${identityStatus.reason ?? "unknown"}`;
  }
  const siteProfile = await getSetting<SiteProfileState>(session.businessId, SETTING_KEYS.siteProfileState);
  const errorText = syncState.lastPushError || syncState.lastPullError || iamError;
  const configured = Boolean(config?.enabled);
  const sync: ConnectionStatus = !configured
    ? "not_configured"
    : errorText
      ? "paused"
      : lastSuccessfulSyncAt
        ? "connected"
        : "connecting";
  const cloud: ConnectionStatus = !configured
    ? "not_configured"
    : errorText
      ? "unreachable"
      : lastSuccessfulSyncAt
        ? "connected"
        : "connecting";
  const state: PlatformConnectionState = {
    localServer: "connected",
    lanGateway: "unknown",
    internet: errorText
      ? "unknown"
      : cloud === "connected"
        ? "connected"
        : "unknown",
    cloud,
    sync,
    externalServices: cloud,
    outboundPending,
    inboundPending: Number(row?.inbound ?? 0),
    deferred: Number(row?.deferred ?? 0),
    conflicts: Number(row?.conflicts ?? 0),
    deadLetters: Number(row?.dead_letters ?? 0),
    lastSuccessfulPushAt,
    lastSuccessfulPullAt,
    lastConvergedAt,
    lastSuccessfulSyncAt,
  };
  return NextResponse.json({
    profile: deployment.profile,
    ...state,
    siteProfile: siteProfile ? { appliedAt: siteProfile.appliedAt, lastError: siteProfile.lastError } : null,
    // Compatibility field for the bounded IndexedDB queue hook.
    cloudSync:
      sync === "connected"
        ? "connected"
        : sync === "connecting"
          ? "connecting"
          : sync === "paused"
            ? "paused"
            : "not_configured",
    error: errorText ? "remote_unreachable" : null,
    // The two identity planes, side by side with the operational state above,
    // plus the combined verdict. A UI that renders a single green badge reads
    // `overallIdentity`; a UI with room for detail renders `identitySync` and
    // `credentialSync` as separate rows (Settings → اتصال و همگام‌سازی).
    identitySync: identityStatus?.configured
      ? {
          state: identityStatus.identity?.state ?? "snapshot_required",
          lastAttemptAt: identityStatus.identity?.lastAttemptAt ?? null,
          lastSuccessAt: identityStatus.identity?.lastSuccessAt ?? null,
          lastError: identityStatus.identity?.lastError ?? null,
        }
      : null,
    credentialSync: identityStatus?.configured
      ? {
          state: identityStatus.credentials?.status ?? "pending",
          lastAttemptAt: identityStatus.credentials?.lastAttemptAt ?? null,
          lastSuccessAt: identityStatus.credentials?.lastSuccessAt ?? null,
          lastError: identityStatus.credentials?.lastError ?? null,
          // Item 11 of issue #843: the shape of the identity plane, so
          // "memberships expected vs identities linked" is visible next to
          // "PIN memberships expected vs usable".
          membershipsExpected: identityStatus.memberships.expected,
          identitiesExpected: identityStatus.memberships.passwordRoles,
          identitiesLinked: identityStatus.memberships.linkedIdentities,
          credentialsReceived: identityStatus.credentials?.credentialsReceived ?? 0,
          pinsReceived: identityStatus.credentials?.pinsReceived ?? 0,
          pinsApplied: identityStatus.credentials?.pinsApplied ?? 0,
          identitiesApplied: identityStatus.credentials?.identitiesApplied ?? 0,
          pinMembersExpected: identityStatus.pinGap.expected,
          pinMembersUsable: identityStatus.pinGap.usable,
          pinMembersMissing: identityStatus.pinGap.missing,
          missingIdentityBindings: identityStatus.missingIdentityBindings,
          convergedAt: identityStatus.credentials?.convergedAt ?? null,
        }
      : null,
    overallIdentity: identityStatus?.overall ?? "not_configured",
    identityError,
    supportRelay: exceptionRelay,
  });
});

function syncStateLastPushed(state: {
  lastPushedEventId?: number | null;
}): number {
  return Number.isSafeInteger(state.lastPushedEventId)
    ? Number(state.lastPushedEventId)
    : 0;
}
