"use client";

/**
 * Issue #884 device registry — owner decision #2: once the bridge is
 * connected inside an authenticated page, ask the app for its persistent
 * installation identity and register it against the business the signed-in
 * member is currently viewing.
 *
 * Mounted once, inside `WorkspaceShell` (the one shell every authenticated
 * route renders) rather than the root layout: the root layout also wraps
 * every public page (marketing, login), which has no session for
 * `/api/native-devices` to register against. By the time this component
 * renders, the member is already authenticated and a business is already
 * selected — the "after login and business selection" the owner decision
 * asked for falls out of where this is mounted, not from logic in here.
 *
 * Renders nothing. A failed attempt (offline, a 409 because the installation
 * is still revoked, a dropped bridge request) is silently retried on the next
 * connection; it never blocks or affects the page, because nothing in the
 * product depends on registration having succeeded except the device list
 * itself and the owner decision's revocation enforcement — neither of which
 * this page is.
 */
import { useEffect } from "react";
import { validateTenantDeepLink } from "@/lib/native/capabilities-client";
import { useNative } from "./native-provider";

const REGISTER_URL = "/api/native-devices";

export function NativeDeviceRegistrar() {
  const { connection, app, request, onEvent } = useNative();

  useEffect(() => {
    const offDeepLink = onEvent("navigation.deepLink", (event) => {
      const check = validateTenantDeepLink({
        path: event.path,
        activeBusinessId: null,
        targetBusinessId: event.businessId,
      });
      if (check.allowed && check.path && typeof window !== "undefined") {
        window.location.assign(check.path);
      }
    });
    const offSync = onEvent("sync.completed", (event) => {
      if (event.revoked && typeof window !== "undefined") {
        void fetch("/api/native-devices/self", { method: "GET" }).then((res) => {
          if (res.status === 401 || res.status === 403) {
            window.location.assign("/login");
          }
        }).catch(() => {});
      }
    });
    return () => {
      offDeepLink();
      offSync();
    };
  }, [onEvent]);

  // `app` only takes on a new value when the runtime store actually records a
  // new connection (native-runtime.ts's `adopt`), not on every unrelated
  // re-render of this component's parents, so this effect re-registers on a
  // genuine (re)connection and nothing else. `cancelled` discards a stale
  // attempt whose connection went away before it finished, which is also
  // what makes React StrictMode's mount→cleanup→mount development double-run
  // safe: the first run's result is discarded, the second one is the one
  // that counts.
  useEffect(() => {
    if (connection !== "connected" || !app) return;
    let cancelled = false;

    (async () => {
      try {
        const identity = await request("device.identity");
        if (cancelled) return;
        await fetch(REGISTER_URL, {
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
      } catch {
        // Offline, an app below bridge version 2 (no device.identity yet), a
        // revoked installation (409 device_revoked — correctly not retried
        // into existence), or any other failure: there is nothing to show the
        // member, and nothing here should interrupt the page they opened the
        // app to use.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, app, request]);

  return null;
}
