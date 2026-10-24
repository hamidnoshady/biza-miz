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
  classifyConnectionFault,
  cloudStatusForFault,
  faultErrorCode,
} from "@/lib/connection-state";
import { probeCloudReachability } from "@/lib/cloud-reachability";
import {
  deliverCloudExceptions,
  pullCloudExceptionResponses,
} from "@/lib/cloud-exception-relay";
import { getLocalActivationView } from "@/lib/local-activation-site-service";
import { readHybridIdentityStatus } from "@/lib/iam/login-credential-sync";
import { readOperationalSyncBlockState } from "@/lib/iam/operational-sync-block";
import { operationalSyncHealth, type OperationalSyncBlockView } from "@/lib/iam/operational-sync-health";

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
    role === "site" && deployment.profile !== "local"
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
      // Not a paired site, so nothing has ever gated its operational traffic.
      operationalBlock: null,
      supportRelay: exceptionRelay,
    });
  }

  if (deployment.profile === "local") {
    const localActivation = await getLocalActivationView(session.businessId);
    const cloudStatus: ConnectionStatus = !localActivation.enrolled
      ? "not_configured"
      : localActivation.state === "locked_invalid"
        ? "attention_required"
        : localActivation.state === "validation_pending"
          ? "unreachable"
          : localActivation.cloudReachable
            ? "connected"
            : "unknown";
    const state: PlatformConnectionState = {
      localServer: "connected",
      lanGateway: "unknown",
      internet: "unknown",
      cloud: cloudStatus,
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
      error: localActivation.lockReason ?? localActivation.lastErrorCode ?? null,
      identitySync: null,
      credentialSync: null,
      overallIdentity: "not_configured",
      identityError: null,
      operationalBlock: null,
      localActivation,
      supportRelay: {
        delivered: 0,
        pending: localActivation.unsentSupportDraftCount,
        configured: localActivation.enrolled,
        received: 0,
      },
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
            WHERE l2.business_id=$1 AND se2.scope='location' AND se2.error='conflict')::text AS conflicts,
         (SELECT count(*) FROM sync_event_dead_letters WHERE business_id=$1 AND status='open')::text AS dead_letters
       FROM sync_events se
       JOIN locations l ON l.id=se.location_id
       WHERE l.business_id=$1 AND se.scope='location'
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
  /*
   * Issue #988 — the gate's own durable record, read next to the identity
   * state rather than inferred from it. `iam_sync_state` describes the last
   * *reconciliation*; this describes what that reconciliation did to the site's
   * operational traffic: master data, push and pull are skipped for as long as
   * it fails, and the tick that skips them used to leave nothing behind but a
   * console line (1 092 of them over nine days on the reported install). The
   * consecutive count is what lets a surface say "blocked since …" instead of
   * "healthy", and the same row carries how many local events the gate is
   * holding back.
   */
  const operationalBlock = config?.enabled && config.siteDeviceId
    ? await readOperationalSyncBlockState(session.businessId, config.siteDeviceId)
    : null;
  const operationalPlane = operationalSyncHealth({
    configured: Boolean(config?.enabled && config.siteDeviceId),
    block: operationalBlock,
  });
  if (operationalPlane.state === "blocked" && !iamError) {
    iamError = `iam_sync_blocked: ${operationalBlock?.lastError ?? operationalPlane.code ?? "operational_sync_blocked"}`;
  }
  let identityError: string | null = null;
  if (identityStatus?.configured && identityStatus.overall === "degraded") {
    // Membership metadata may be fine; the login plane is not. The connection
    // badge must not be green, but the operational pipes are still up, so this
    // rides as its own signal rather than as "cloud unreachable".
    identityError = `identity_sync_degraded: ${identityStatus.reason ?? "unknown"}`;
  }
  const operationalBlockView: OperationalSyncBlockView = {
    state: operationalPlane.state,
    blocked: operationalPlane.state === "blocked",
    /** The block has run past OPERATIONAL_SYNC_ALERT_AFTER_TICKS. */
    alertDue: operationalPlane.alertDue,
    consecutiveBlockedTicks: operationalPlane.consecutiveBlockedTicks,
    blockedSince: operationalBlock?.firstBlockedAt ?? null,
    lastBlockedAt: operationalBlock?.lastBlockedAt ?? null,
    lastRecoveredAt: operationalBlock?.lastRecoveredAt ?? null,
    code: operationalPlane.code,
    // Kept for support's tooltip/diagnostics; a screen renders `code`, never
    // this raw string.
    lastError: operationalBlock?.lastError ?? null,
    pendingOutbox: operationalBlock?.pendingOutbox ?? 0,
    episodesBlocked: operationalBlock?.episodesBlocked ?? 0,
  };
  const siteProfile = await getSetting<SiteProfileState>(session.businessId, SETTING_KEYS.siteProfileState);
  // Issue #948 P0/P1-5 — classify the *persisted* errors instead of folding
  // them into one "remote_unreachable". A push/pull error is evidence about
  // the last sync attempt, not about the Internet; an IAM/identity error is
  // its own plane; only a transport-class failure may claim the cloud is
  // unreachable.
  const operationalError = syncState.lastPushError || syncState.lastPullError || null;
  const errorText = operationalError || iamError;
  const fault = classifyConnectionFault(errorText);
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
      ? cloudStatusForFault(fault)
      : lastSuccessfulSyncAt
        ? "connected"
        : "connecting";
  // A fresh, bounded reachability probe of the cloud host — the "current"
  // transport fact the persisted errors cannot provide.
  const reachability = config?.remoteUrl
    ? await probeCloudReachability(config.remoteUrl).catch(() => ({
        state: "unknown" as const,
        checkedAt: null,
        cached: true,
        httpStatus: null,
      }))
    : { state: "unknown" as const, checkedAt: null, cached: true, httpStatus: null };
  const state: PlatformConnectionState = {
    localServer: "connected",
    lanGateway: "unknown",
    // Never inferred downward from a sync error: "connected" only while the
    // cloud pipe demonstrably works, otherwise *unknown* — the browser's own
    // `navigator.onLine` is the only authority on the local network, and a
    // stale push error is no authority on the Internet at all.
    internet: cloud === "connected" ? "connected" : "unknown",
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
    error: faultErrorCode(fault),
    fault,
    // Issue #948 — the typed, *independent* connection-health model. Each
    // dimension answers its own question; nothing here is inferred from
    // another dimension's stale error. Toasts, banners, the status badge,
    // /settings/cloud-sync and the embedded cloud pane all consume this one
    // classified state.
    health: {
      localServer: "connected" as const,
      /** The browser's network is only knowable client-side; merged in the UI. */
      browserNetwork: "reported_by_client" as const,
      internet: state.internet,
      cloudReachability: reachability,
      cloudAuth:
        fault === "auth_expired"
          ? ("auth_expired" as const)
          : fault === "forbidden"
            ? ("forbidden" as const)
            : operationalError && !iamError
              ? ("unknown" as const)
              : ("ok" as const),
      operationalSync: sync,
      /**
       * Issue #988 — is the security plane holding this site's master data,
       * push and pull back *right now*? Independent of `operationalSync` above:
       * a blocked install has no push error of its own, it has no push at all.
       */
      operationalBlock: operationalBlockView,
      iamMembership: identityStatus?.configured
        ? {
            state: identityStatus.identity?.state ?? "snapshot_required",
            lastError: identityStatus.identity?.lastError ?? null,
            lastSuccessAt: identityStatus.identity?.lastSuccessAt ?? null,
          }
        : null,
      credentialSync: identityStatus?.configured
        ? {
            state: identityStatus.credentials?.status ?? "pending",
            lastError: identityStatus.credentials?.lastError ?? null,
            lastSuccessAt: identityStatus.credentials?.lastSuccessAt ?? null,
            identityContract: identityStatus.credentials?.identityContract ?? null,
          }
        : null,
      identityBinding: {
        missing: identityStatus?.missingIdentityBindings ?? 0,
        repairedLastPass: identityStatus?.credentials?.identityMismatches ?? 0,
        rekeyedLastPass: identityStatus?.credentials?.identityRekeys ?? 0,
      },
      queue: {
        outboundPending,
        inboundPending: Number(row?.inbound ?? 0),
        deferred: Number(row?.deferred ?? 0),
        conflicts: Number(row?.conflicts ?? 0),
        deadLetters: Number(row?.dead_letters ?? 0),
      },
      lastSuccessfulContactAt: lastSuccessfulSyncAt,
    },
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
          // Issue #850: PINs the cloud removed and this site revoked.
          pinsRevoked: identityStatus.credentials?.pinsRevoked ?? 0,
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
    // Issue #987: the flag is now properly cleared by acknowledgePendingPairing()
    // and surfaced here so the UI can distinguish "pairing still finalising"
    // from a sync error while the acknowledgement is in flight.
    pairingPending: Boolean(config?.pairingPending),
    // The operational plane's own verdict, next to the two identity planes, so
    // a reader can tell "identity needs attention" from "no sales are leaving
    // this till" — which used to be the same blank spot in every surface.
    operationalBlock: operationalBlockView,
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
