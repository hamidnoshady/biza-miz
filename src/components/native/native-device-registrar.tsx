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
 * 3. Reconciles native background sync (`sync.completed`) with the web IndexedDB
 *    offline mutation queue (`flushQueue`) and enforces device revocation.
 */
import { useEffect, useRef } from "react";
import type { NativeDeepLinkEvent } from "@/lib/native/bridge-contract";
import {
  triggerNativeBackgroundSync,
  validateTenantDeepLink,
} from "@/lib/native/capabilities-client";
import { flushQueue } from "@/app/dashboard/offline-queue";
import { useNative } from "./native-provider";

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

export interface NativeDeviceRegistrarProps {
  /** Authoritative active business ID from `WorkspaceShell`'s server session. */
  businessId?: string | null;
}

export function NativeDeviceRegistrar({ businessId = null }: NativeDeviceRegistrarProps = {}) {
  const { connection, app, request, onEvent } = useNative();
  const previousBusinessIdRef = useRef<string | null>(businessId?.trim() || null);

  // If the server-rendered businessId prop changes across navigations (tenant switch),
  // clear the previous tenant's native operational state and caller ID cache immediately.
  useEffect(() => {
    const currentBiz = businessId?.trim() || null;
    const prevBiz = previousBusinessIdRef.current;
    if (prevBiz && currentBiz && prevBiz !== currentBiz && connection === "connected") {
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
          await triggerNativeBackgroundSync(request, {
            action: "clear_tenant",
            businessId: oldBizId,
          });
        },
        onClearAll: async () => {
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

    const offSync = onEvent("sync.completed", (event) => {
      if (event.revoked && typeof window !== "undefined") {
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
        return;
      }
      // Reconcile the web IndexedDB offline mutation queue when Android background sync completes.
      void flushQueue();
    });

    return () => {
      offDeepLink();
      offSync();
    };
  }, [businessId, onEvent, request]);

  useEffect(() => {
    if (connection !== "connected" || !app) return;
    let cancelled = false;

    (async () => {
      try {
        const identity = await request("device.identity");
        if (cancelled) return;
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
        }
      } catch {
        // Offline, an app below bridge version 2 (no device.identity yet), a
        // revoked installation, or any other failure: never interrupt the page.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, app, request]);

  return null;
}
