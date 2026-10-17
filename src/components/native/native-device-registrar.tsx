"use client";

/**
 * Issue #884 device registry & native lifecycle coordinator:
 * 1. Once the bridge is connected inside an authenticated page (`WorkspaceShell`),
 *    asks the Android app for its persistent installation identity and registers
 *    it against the business the signed-in member is currently viewing.
 * 2. Resolves authoritative tenant context (`businessId` prop from `WorkspaceShell`
 *    verified against `GET /api/auth/me`) before routing any `navigation.deepLink`
 *    event. Mismatched tenants are authorized via `POST /api/auth/switch-business`
 *    (wiping the previous tenant's local native caches first) or rejected when
 *    unauthorized; missing or revoked sessions fail closed.
 * 3. Coordinates native background sync with the canonical web IndexedDB
 *    offline mutation queue (`flushQueue` -> `POST /api/sync/events`):
 *    - Android `BizaSyncWorker` probes `/api/health` and emits `sync.reconcileRequested`
 *      (or persists `state = "waiting_for_app"` when the browser is closed).
 *    - `reconcileNativeSyncRequest` verifies `businessId`, `installationId`,
 *      `sessionGeneration`, and `syncRequestId` deduplication before calling
 *      `flushQueue()` and acknowledging exact `flushedCount` / `remainingCount`
 *      via `sync.acknowledge`.
 *    - `lastSyncedAt` and `pendingCount = 0` are NEVER stamped from `/api/health`;
 *      they are updated only when `flushQueue()` actually flushes queued writes.
 */
import { useEffect, useRef } from "react";
import type {
  NativeAppInfo,
  NativeDeepLinkEvent,
  NativeSyncAcknowledgeReason,
  NativeSyncAcknowledgeResult,
  NativeSyncReconcileRequestedEvent,
} from "@/lib/native/bridge-contract";
import {
  acknowledgeNativeBackgroundSync,
  getNativeSyncStatus,
  triggerNativeBackgroundSync,
  validateTenantDeepLink,
} from "@/lib/native/capabilities-client";
import { flushQueue, type FlushQueueResult } from "@/app/dashboard/offline-queue";
import { useNative, type NativeRequest } from "./native-provider";

const REGISTER_URL = "/api/native-devices";

export interface DeepLinkResolutionOptions {
  fallbackBusinessId?: string | null;
  previousBusinessId?: string | null;
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  onClearTenant?: (businessId: string) => Promise<void> | void;
  onClearAll?: () => Promise<void> | void;
}

export interface DeepLinkResolutionResult {
  routed: boolean;
  destination: string | null;
  authoritativeBusinessId: string | null;
  clearedPreviousBusinessId: string | null;
  reason:
    | "routed"
    | "switched_and_routed"
    | "invalid_path"
    | "missing_active_tenant"
    | "tenant_mismatch_forbidden"
    | "session_revoked";
}

/**
 * Resolves the authoritative active business from `/api/auth/me` (falling back
 * to `fallbackBusinessId` only if `/api/auth/me` cannot be reached offline when
 * no cross-tenant switch is needed), reconciles tenant changes, and validates or
 * switches tenant scope before navigating to `event.path`.
 */
export async function resolveAndRouteNativeDeepLink(
  event: NativeDeepLinkEvent,
  options: DeepLinkResolutionOptions = {},
): Promise<DeepLinkResolutionResult> {
  const fetchFn = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const navigate =
    options.navigate ??
    ((url: string) => {
      if (typeof window !== "undefined") {
        window.location.assign(url);
      }
    });

  // 1. Validate path syntax first before any network call.
  const syntaxCheck = validateTenantDeepLink({
    path: event.path,
    activeBusinessId: "syntax-probe",
    targetBusinessId: null,
  });
  if (!syntaxCheck.allowed || !syntaxCheck.path) {
    return {
      routed: false,
      destination: null,
      authoritativeBusinessId: null,
      clearedPreviousBusinessId: null,
      reason: "invalid_path",
    };
  }
  const cleanPath = syntaxCheck.path;

  // 2. Resolve authoritative tenant from /api/auth/me when fetch is available.
  let authoritativeBusinessId: string | null = options.fallbackBusinessId?.trim() || null;
  if (fetchFn) {
    try {
      const meRes = await fetchFn("/api/auth/me", { method: "GET", cache: "no-store" });
      if (meRes.status === 401 || meRes.status === 403) {
        await options.onClearAll?.();
        navigate("/login");
        return {
          routed: false,
          destination: "/login",
          authoritativeBusinessId: null,
          clearedPreviousBusinessId: null,
          reason: "session_revoked",
        };
      }
      if (meRes.ok) {
        const body = (await meRes.json()) as { user?: { businessId?: string | null } };
        authoritativeBusinessId = body.user?.businessId?.trim() || authoritativeBusinessId;
      }
    } catch {
      // Network unreachable: rely on fallbackBusinessId from WorkspaceShell if present.
    }
  }

  // 3. Detect if the active business changed since last tracked render/session.
  let clearedPreviousBusinessId: string | null = null;
  const prevBiz = options.previousBusinessId?.trim() || null;
  if (prevBiz && authoritativeBusinessId && prevBiz !== authoritativeBusinessId) {
    await options.onClearTenant?.(prevBiz);
    clearedPreviousBusinessId = prevBiz;
  }

  // 4. Validate deep link against authoritative active business.
  const check = validateTenantDeepLink({
    path: cleanPath,
    activeBusinessId: authoritativeBusinessId,
    targetBusinessId: event.businessId,
  });

  if (check.allowed && check.path) {
    navigate(check.path);
    return {
      routed: true,
      destination: check.path,
      authoritativeBusinessId,
      clearedPreviousBusinessId,
      reason: "routed",
    };
  }

  if (check.reason === "missing_active_tenant") {
    return {
      routed: false,
      destination: null,
      authoritativeBusinessId: null,
      clearedPreviousBusinessId,
      reason: "missing_active_tenant",
    };
  }

  // 5. Tenant mismatch: attempt server-authorized switch via POST /api/auth/switch-business.
  const targetBusinessId = event.businessId?.trim() || null;
  if (check.reason === "tenant_mismatch" && targetBusinessId && fetchFn) {
    try {
      const switchRes = await fetchFn("/api/auth/switch-business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: targetBusinessId }),
      });
      if (switchRes.status === 401) {
        await options.onClearAll?.();
        navigate("/login");
        return {
          routed: false,
          destination: "/login",
          authoritativeBusinessId: null,
          clearedPreviousBusinessId,
          reason: "session_revoked",
        };
      }
      if (switchRes.ok) {
        if (authoritativeBusinessId && authoritativeBusinessId !== targetBusinessId) {
          await options.onClearTenant?.(authoritativeBusinessId);
          clearedPreviousBusinessId = authoritativeBusinessId;
        }
        navigate(cleanPath);
        return {
          routed: true,
          destination: cleanPath,
          authoritativeBusinessId: targetBusinessId,
          clearedPreviousBusinessId,
          reason: "switched_and_routed",
        };
      }
    } catch {
      // Network failure during business switch: fail closed rather than routing into wrong tenant.
    }
  }

  return {
    routed: false,
    destination: null,
    authoritativeBusinessId,
    clearedPreviousBusinessId,
    reason: "tenant_mismatch_forbidden",
  };
}

export interface ReconcileNativeSyncOptions {
  request: NativeRequest;
  activeBusinessId: string | null;
  activeInstallationId?: string | null;
  activeSessionGeneration?: number | null;
  acknowledgedRequestIds?: Set<string>;
  flushImpl?: () => Promise<FlushQueueResult>;
  fetchImpl?: typeof fetch;
  app?: NativeAppInfo | null;
}

export interface ReconcileNativeSyncOutcome {
  accepted: boolean;
  reason: NativeSyncAcknowledgeReason;
  flushedCount: number;
  remainingCount: number;
  lastSyncedAt: string | null;
  acknowledgeResult: NativeSyncAcknowledgeResult | null;
}

/**
 * Handles a `sync.reconcileRequested` event (or a durable `waiting_for_app`
 * request discovered on reconnect) by validating tenant, installation,
 * session generation, and request deduplication before flushing IndexedDB
 * `pendingActions` to `/api/sync/events` and acknowledging the real outcome
 * back to Android `TenantSyncStateStore`.
 */
export async function reconcileNativeSyncRequest(
  event: NativeSyncReconcileRequestedEvent,
  options: ReconcileNativeSyncOptions,
): Promise<ReconcileNativeSyncOutcome> {
  const activeBiz = options.activeBusinessId?.trim() || null;
  const eventBiz = event.businessId?.trim() || "";
  if (!activeBiz || !eventBiz || activeBiz !== eventBiz) {
    return {
      accepted: false,
      reason: "tenant_mismatch",
      flushedCount: 0,
      remainingCount: event.pendingCount,
      lastSyncedAt: null,
      acknowledgeResult: null,
    };
  }

  const activeInst = options.activeInstallationId?.trim() || null;
  const eventInst = event.installationId?.trim() || null;
  if (activeInst && eventInst && activeInst !== eventInst) {
    return {
      accepted: false,
      reason: "installation_mismatch",
      flushedCount: 0,
      remainingCount: event.pendingCount,
      lastSyncedAt: null,
      acknowledgeResult: null,
    };
  }

  const activeGen = options.activeSessionGeneration ?? null;
  const eventGen = event.sessionGeneration ?? null;
  if (activeGen !== null && eventGen !== null && activeGen !== eventGen) {
    return {
      accepted: false,
      reason: "session_generation_mismatch",
      flushedCount: 0,
      remainingCount: event.pendingCount,
      lastSyncedAt: null,
      acknowledgeResult: null,
    };
  }

  if (options.acknowledgedRequestIds?.has(event.syncRequestId)) {
    return {
      accepted: false,
      reason: "duplicate_or_stale",
      flushedCount: 0,
      remainingCount: event.pendingCount,
      lastSyncedAt: null,
      acknowledgeResult: null,
    };
  }

  const flushFn = options.flushImpl ?? flushQueue;
  const flushOutcome = await flushFn();

  const ack = await acknowledgeNativeBackgroundSync(options.request, {
    businessId: activeBiz,
    syncRequestId: event.syncRequestId,
    flushedCount: flushOutcome.flushedCount,
    remainingCount: flushOutcome.remainingCount,
    failedCount: flushOutcome.failedCount,
    conflictCount: flushOutcome.conflictCount,
    transientFailure: flushOutcome.transientFailure,
    installationId: activeInst ?? eventInst,
    sessionGeneration: activeGen ?? eventGen,
    completedAt: flushOutcome.completedAt,
  });

  if (ack.accepted && !flushOutcome.transientFailure) {
    options.acknowledgedRequestIds?.add(event.syncRequestId);
  }

  // Stamp server-side native_app_devices.last_synced_at ONLY when real business
  // events were flushed and acknowledged by Android.
  const fetchFn = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (
    ack.accepted &&
    !flushOutcome.transientFailure &&
    ack.flushedCount > 0 &&
    ack.lastSyncedAt &&
    activeInst &&
    options.app &&
    fetchFn
  ) {
    try {
      await fetchFn(REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: activeInst,
          environment: options.app.environment,
          appVersionName: options.app.appVersionName,
          appVersionCode: options.app.appVersionCode,
          bridgeVersion: options.app.bridgeVersion,
          lastSyncedAt: ack.lastSyncedAt,
        }),
      });
    } catch {
      // Best-effort metadata update; local acknowledgement already succeeded.
    }
  }

  return {
    accepted: ack.accepted,
    reason: ack.reason,
    flushedCount: ack.flushedCount,
    remainingCount: ack.remainingCount,
    lastSyncedAt: ack.lastSyncedAt,
    acknowledgeResult: ack,
  };
}

export interface NativeDeviceRegistrarProps {
  /** Authoritative active business ID from `WorkspaceShell`'s server session. */
  businessId?: string | null;
}

export function NativeDeviceRegistrar({ businessId = null }: NativeDeviceRegistrarProps = {}) {
  const { connection, app, request, onEvent } = useNative();
  const previousBusinessIdRef = useRef<string | null>(businessId?.trim() || null);
  const installationIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef<number | null>(null);
  const acknowledgedRequestIdsRef = useRef<Set<string>>(new Set());

  // If the server-rendered businessId prop changes across navigations (tenant switch),
  // clear the previous tenant's native operational state and caller ID cache immediately.
  useEffect(() => {
    const currentBiz = businessId?.trim() || null;
    const prevBiz = previousBusinessIdRef.current;
    if (prevBiz && currentBiz && prevBiz !== currentBiz && connection === "connected") {
      acknowledgedRequestIdsRef.current.clear();
      void triggerNativeBackgroundSync(request, {
        action: "clear_tenant",
        businessId: prevBiz,
      });
    }
    if (currentBiz) {
      previousBusinessIdRef.current = currentBiz;
    }
  }, [businessId, connection, request]);

  useEffect(() => {
    const offDeepLink = onEvent("navigation.deepLink", (event) => {
      void resolveAndRouteNativeDeepLink(event, {
        fallbackBusinessId: businessId,
        previousBusinessId: previousBusinessIdRef.current,
        onClearTenant: async (oldBizId) => {
          acknowledgedRequestIdsRef.current.clear();
          await triggerNativeBackgroundSync(request, {
            action: "clear_tenant",
            businessId: oldBizId,
          });
        },
        onClearAll: async () => {
          acknowledgedRequestIdsRef.current.clear();
          await triggerNativeBackgroundSync(request, {
            action: "clear_all",
            businessId: null,
          });
        },
      }).then((res) => {
        if (res.authoritativeBusinessId) {
          previousBusinessIdRef.current = res.authoritativeBusinessId;
        }
      });
    });

    const offReconcile = onEvent("sync.reconcileRequested", (event) => {
      void reconcileNativeSyncRequest(event, {
        request,
        activeBusinessId: businessId,
        activeInstallationId: installationIdRef.current,
        activeSessionGeneration: sessionGenerationRef.current,
        acknowledgedRequestIds: acknowledgedRequestIdsRef.current,
        app,
      });
    });

    const offSyncCompleted = onEvent("sync.completed", (event) => {
      if (event.revoked && typeof window !== "undefined") {
        acknowledgedRequestIdsRef.current.clear();
        void triggerNativeBackgroundSync(request, {
          action: "clear_all",
          businessId: null,
        });
        void fetch("/api/native-devices/self", { method: "GET" })
          .then((res) => {
            if (res.status === 401 || res.status === 403) {
              window.location.assign("/login");
            }
          })
          .catch(() => {});
      }
    });

    return () => {
      offDeepLink();
      offReconcile();
      offSyncCompleted();
    };
  }, [app, businessId, onEvent, request]);

  // Reconcile native sync status when the web queue flushes directly (e.g., user-initiated
  // or auto-online flush while a native syncRequestId is scheduled).
  useEffect(() => {
    if (typeof window === "undefined" || connection !== "connected" || !app) return;
    if (app.bridgeVersion < 3 || !app.capabilities.includes("background.sync")) return;
    const activeBiz = businessId?.trim() || null;
    if (!activeBiz) return;

    function handleQueueFlushed(e: Event) {
      const detail = (e as CustomEvent<FlushQueueResult>).detail;
      if (!detail || !activeBiz) return;
      void (async () => {
        const status = await getNativeSyncStatus(request, activeBiz);
        const syncRequestId = status.pendingSyncRequestId ?? null;
        if (
          !syncRequestId ||
          acknowledgedRequestIdsRef.current.has(syncRequestId) ||
          (status.pendingCount === 0 && !status.scheduled && !status.waitingForApp)
        ) {
          return;
        }
        const ack = await acknowledgeNativeBackgroundSync(request, {
          businessId: activeBiz,
          syncRequestId,
          flushedCount: detail.flushedCount,
          remainingCount: detail.remainingCount,
          failedCount: detail.failedCount,
          conflictCount: detail.conflictCount,
          transientFailure: detail.transientFailure,
          installationId: installationIdRef.current,
          sessionGeneration: sessionGenerationRef.current,
          completedAt: detail.completedAt,
        });
        if (ack.accepted && !detail.transientFailure) {
          acknowledgedRequestIdsRef.current.add(syncRequestId);
        }
      })();
    }

    window.addEventListener("biza:offline-queue-flushed", handleQueueFlushed);
    return () => {
      window.removeEventListener("biza:offline-queue-flushed", handleQueueFlushed);
    };
  }, [app, businessId, connection, request]);

  useEffect(() => {
    if (connection !== "connected" || !app) return;
    let cancelled = false;

    (async () => {
      try {
        const identity = await request("device.identity");
        if (cancelled) return;
        installationIdRef.current = identity.installationId;
        const res = await fetch(REGISTER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            installationId: identity.installationId,
            environment: app.environment,
            appVersionName: app.appVersionName,
            appVersionCode: app.appVersionCode,
            bridgeVersion: app.bridgeVersion,
          }),
        });
        if (!cancelled && (res.status === 401 || res.status === 403 || res.status === 409)) {
          if (app.bridgeVersion >= 3 && app.capabilities.includes("background.sync")) {
            await triggerNativeBackgroundSync(request, {
              action: "clear_all",
              businessId: null,
            });
          }
          return;
        }
        if (!cancelled && res.ok) {
          try {
            const payload = (await res.json()) as {
              device?: { sessionGeneration?: number | null };
            };
            if (typeof payload.device?.sessionGeneration === "number") {
              sessionGenerationRef.current = payload.device.sessionGeneration;
            }
          } catch {
            // Ignore non-JSON body in minimal test stubs.
          }
        }

        // If Android WorkManager probed /api/health while the browser was closed,
        // TenantSyncStateStore persisted state = "waiting_for_app" with a durable
        // pendingSyncRequestId. Reconcile it now that the web runtime is active.
        const activeBiz = businessId?.trim() || null;
        if (
          !cancelled &&
          activeBiz &&
          app.bridgeVersion >= 3 &&
          app.capabilities.includes("background.sync")
        ) {
          const status = await getNativeSyncStatus(request, activeBiz);
          if (
            !cancelled &&
            (status.waitingForApp || status.state === "waiting_for_app") &&
            status.pendingSyncRequestId
          ) {
            await reconcileNativeSyncRequest(
              {
                businessId: activeBiz,
                syncRequestId: status.pendingSyncRequestId,
                pendingCount: status.pendingCount,
                requestedAt: new Date().toISOString(),
                installationId: status.installationId ?? identity.installationId,
                sessionGeneration: status.sessionGeneration ?? sessionGenerationRef.current,
              },
              {
                request,
                activeBusinessId: activeBiz,
                activeInstallationId: identity.installationId,
                activeSessionGeneration: sessionGenerationRef.current,
                acknowledgedRequestIds: acknowledgedRequestIdsRef.current,
                app,
              },
            );
          }
        }
      } catch {
        // Offline, an app below bridge version 2 (no device.identity yet), a
        // revoked installation, or any other failure: never interrupt the page.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [businessId, connection, app, request]);

  return null;
}
