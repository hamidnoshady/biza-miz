// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_BROWSER_FEATURES } from "@/lib/native/capability";
import { INITIAL_NATIVE_SNAPSHOT, type NativeRuntimeSnapshot } from "@/lib/native/native-runtime";
import {
  NativeDeviceRegistrar,
  reconcileNativeSyncRequest,
  resolveAndRouteNativeDeepLink,
} from "./native-device-registrar";
import { NativeValueProvider, buildNativeContextValue, type NativeRequest } from "./native-provider";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONNECTED_SNAPSHOT: NativeRuntimeSnapshot = {
  kind: "android-twa",
  connection: "connected",
  androidPackage: "com.bizamiz.app",
  environment: "production",
  app: {
    appVersionName: "0.1.0",
    appVersionCode: 4,
    environment: "production",
    bridgeVersion: 2,
    capabilities: ["notifications"],
  },
};

describe("NativeDeviceRegistrar", () => {
  it("never calls the bridge or the network outside a connected channel", () => {
    const request = vi.fn() as unknown as NativeRequest;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <NativeValueProvider value={buildNativeContextValue(INITIAL_NATIVE_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );
    expect(request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the installation identity and registers it once the channel connects", async () => {
    const request = vi.fn(async (command: string) => {
      expect(command).toBe("device.identity");
      return { installationId: "a1b2c3d4e5f6" };
    }) as unknown as NativeRequest;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ device: {} }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("device.identity");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/native-devices");
    expect(JSON.parse(init!.body as string)).toEqual({
      installationId: "a1b2c3d4e5f6",
      environment: "production",
      appVersionName: "0.1.0",
      appVersionCode: 4,
      bridgeVersion: 2,
    });
  });

  it("never throws when the app is too old for device.identity", async () => {
    const request = vi.fn(async () => {
      throw new Error("bridge_version_too_old");
    }) as unknown as NativeRequest;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when registration itself fails (offline, 409 device_revoked, ...)", async () => {
    const request = vi.fn(async () => ({ installationId: "a1b2c3d4e5f6" })) as unknown as NativeRequest;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("resolveAndRouteNativeDeepLink (Root Cause 5)", () => {
  it("routes when target businessId matches authoritative active business from /api/auth/me", async () => {
    const navigate = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("/api/auth/me");
      return new Response(JSON.stringify({ user: { id: "u-1", businessId: "biz-active" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/crm/customers/42",
        businessId: "biz-active",
        notificationCategory: "crm",
      },
      {
        fallbackBusinessId: "biz-active",
        fetchImpl: fetchMock,
        navigate,
      },
    );

    expect(res).toEqual({
      routed: true,
      destination: "/crm/customers/42",
      authoritativeBusinessId: "biz-active",
      clearedPreviousBusinessId: null,
      reason: "routed",
    });
    expect(navigate).toHaveBeenCalledWith("/crm/customers/42");
  });

  it("blocks routing when target businessId is specified and active business cannot be resolved (missing tenant)", async () => {
    const navigate = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ user: { id: "u-1", businessId: null } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/accounting/orders",
        businessId: "biz-target",
        notificationCategory: "orders",
      },
      {
        fallbackBusinessId: null,
        fetchImpl: fetchMock,
        navigate,
      },
    );

    expect(res.routed).toBe(false);
    expect(res.reason).toBe("missing_active_tenant");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("switches business and clears previous tenant cache when target businessId is authorized via /api/auth/switch-business", async () => {
    const navigate = vi.fn();
    const onClearTenant = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") {
        return new Response(JSON.stringify({ user: { id: "u-1", businessId: "biz-old" } }), {
          status: 200,
        });
      }
      if (url === "/api/auth/switch-business") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({ businessId: "biz-new" });
        return new Response(JSON.stringify({ businessId: "biz-new" }), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/accounting/invoices/99",
        businessId: "biz-new",
        notificationCategory: "orders",
      },
      {
        fallbackBusinessId: "biz-old",
        fetchImpl: fetchMock,
        navigate,
        onClearTenant,
      },
    );

    expect(res).toEqual({
      routed: true,
      destination: "/accounting/invoices/99",
      authoritativeBusinessId: "biz-new",
      clearedPreviousBusinessId: "biz-old",
      reason: "switched_and_routed",
    });
    expect(onClearTenant).toHaveBeenCalledWith("biz-old");
    expect(navigate).toHaveBeenCalledWith("/accounting/invoices/99");
  });

  it("blocks routing when target businessId is unauthorized (403 on /api/auth/switch-business)", async () => {
    const navigate = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        return new Response(JSON.stringify({ user: { id: "u-1", businessId: "biz-1" } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    }) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/crm/customers",
        businessId: "biz-unauthorized",
        notificationCategory: "crm",
      },
      {
        fallbackBusinessId: "biz-1",
        fetchImpl: fetchMock,
        navigate,
      },
    );

    expect(res.routed).toBe(false);
    expect(res.reason).toBe("tenant_mismatch_forbidden");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("clears previous tenant cache when authoritative business changed since previous render", async () => {
    const navigate = vi.fn();
    const onClearTenant = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ user: { id: "u-1", businessId: "biz-2" } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/dashboard",
        businessId: "biz-2",
        notificationCategory: null,
      },
      {
        fallbackBusinessId: "biz-2",
        previousBusinessId: "biz-1",
        fetchImpl: fetchMock,
        navigate,
        onClearTenant,
      },
    );

    expect(res.routed).toBe(true);
    expect(res.clearedPreviousBusinessId).toBe("biz-1");
    expect(onClearTenant).toHaveBeenCalledWith("biz-1");
  });

  it("wipes all native state and redirects to /login when session is revoked (401 on /api/auth/me)", async () => {
    const navigate = vi.fn();
    const onClearAll = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    ) as unknown as typeof fetch;

    const res = await resolveAndRouteNativeDeepLink(
      {
        path: "/accounting/orders",
        businessId: "biz-1",
        notificationCategory: "orders",
      },
      {
        fallbackBusinessId: "biz-1",
        fetchImpl: fetchMock,
        navigate,
        onClearAll,
      },
    );

    expect(res.routed).toBe(false);
    expect(res.reason).toBe("session_revoked");
    expect(res.destination).toBe("/login");
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/login");
  });
});

describe("reconcileNativeSyncRequest & background sync producer/consumer boundary", () => {
  const V3_APP = {
    appVersionName: "1.2.0",
    appVersionCode: 12,
    environment: "production" as const,
    bridgeVersion: 3,
    capabilities: ["notifications", "background.sync"] as const,
  };

  it("never marks business sync complete when /api/health succeeded on Android but /api/sync/events fails transiently", async () => {
    const request = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
      expect(command).toBe("sync.acknowledge");
      expect(payload).toMatchObject({
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_health_ok",
        flushedCount: 0,
        remainingCount: 3,
        transientFailure: true,
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      });
      return {
        accepted: true,
        reason: "partial_remaining",
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_health_ok",
        flushedCount: 0,
        remainingCount: 3,
        lastSyncedAt: null,
        state: "retrying",
      };
    }) as unknown as NativeRequest;

    const fetchMock = vi.fn() as unknown as typeof fetch;
    const acknowledgedIds = new Set<string>();

    const outcome = await reconcileNativeSyncRequest(
      {
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_health_ok",
        pendingCount: 3,
        requestedAt: "2026-10-16T08:01:00.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      },
      {
        request,
        activeBusinessId: "biz-1",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 4,
        acknowledgedRequestIds: acknowledgedIds,
        flushImpl: async () => ({
          attemptedCount: 3,
          flushedCount: 0,
          remainingCount: 3,
          failedCount: 0,
          conflictCount: 0,
          transientFailure: true,
          completedAt: "2026-10-16T08:01:02.000Z",
        }),
        fetchImpl: fetchMock,
        app: { ...V3_APP, capabilities: [...V3_APP.capabilities] },
      },
    );

    expect(outcome.flushedCount).toBe(0);
    expect(outcome.remainingCount).toBe(3);
    expect(outcome.lastSyncedAt).toBeNull();
    // Transient failure must not mark the request ID as permanently consumed or stamp server lastSyncedAt.
    expect(acknowledgedIds.has("syncreq_biz1_health_ok")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates lastSyncedAt and server device metadata only after queue events actually flush", async () => {
    const request = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
      expect(command).toBe("sync.acknowledge");
      expect(payload).toMatchObject({
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_flush_ok",
        flushedCount: 3,
        remainingCount: 0,
        transientFailure: false,
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      });
      return {
        accepted: true,
        reason: "acknowledged",
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_flush_ok",
        flushedCount: 3,
        remainingCount: 0,
        lastSyncedAt: "2026-10-16T08:05:00.000Z",
        state: "idle",
      };
    }) as unknown as NativeRequest;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device: {} }), { status: 201 })) as unknown as typeof fetch;
    const acknowledgedIds = new Set<string>();

    const outcome = await reconcileNativeSyncRequest(
      {
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_flush_ok",
        pendingCount: 3,
        requestedAt: "2026-10-16T08:04:55.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      },
      {
        request,
        activeBusinessId: "biz-1",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 4,
        acknowledgedRequestIds: acknowledgedIds,
        flushImpl: async () => ({
          attemptedCount: 3,
          flushedCount: 3,
          remainingCount: 0,
          failedCount: 0,
          conflictCount: 0,
          transientFailure: false,
          completedAt: "2026-10-16T08:05:00.000Z",
        }),
        fetchImpl: fetchMock,
        app: { ...V3_APP, capabilities: [...V3_APP.capabilities] },
      },
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe("acknowledged");
    expect(outcome.flushedCount).toBe(3);
    expect(outcome.remainingCount).toBe(0);
    expect(outcome.lastSyncedAt).toBe("2026-10-16T08:05:00.000Z");
    expect(acknowledgedIds.has("syncreq_biz1_flush_ok")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      installationId: "inst-alpha-1234567890",
      lastSyncedAt: "2026-10-16T08:05:00.000Z",
    });
  });

  it("preserves remainingCount > 0 on partial failure", async () => {
    const request = vi.fn(async (_command: string, payload?: Record<string, unknown>) => {
      expect(payload).toMatchObject({
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_partial",
        flushedCount: 2,
        remainingCount: 1,
        failedCount: 1,
      });
      return {
        accepted: true,
        reason: "partial_remaining",
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_partial",
        flushedCount: 2,
        remainingCount: 1,
        lastSyncedAt: "2026-10-16T08:10:00.000Z",
        state: "scheduled",
      };
    }) as unknown as NativeRequest;

    const outcome = await reconcileNativeSyncRequest(
      {
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_partial",
        pendingCount: 3,
        requestedAt: "2026-10-16T08:09:50.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      },
      {
        request,
        activeBusinessId: "biz-1",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 4,
        flushImpl: async () => ({
          attemptedCount: 3,
          flushedCount: 2,
          remainingCount: 1,
          failedCount: 1,
          conflictCount: 0,
          transientFailure: false,
          completedAt: "2026-10-16T08:10:00.000Z",
        }),
      },
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe("partial_remaining");
    expect(outcome.flushedCount).toBe(2);
    expect(outcome.remainingCount).toBe(1);
    expect(outcome.acknowledgeResult?.state).toBe("scheduled");
  });

  it("rejects duplicate, cross-tenant, mismatched-installation, and stale-session-generation reconcile requests without flushing", async () => {
    const request = vi.fn() as unknown as NativeRequest;
    const flushImpl = vi.fn();
    const acknowledgedIds = new Set<string>(["syncreq_already_done"]);

    // 1. Cross-tenant
    const tenantMismatch = await reconcileNativeSyncRequest(
      {
        businessId: "biz-other",
        syncRequestId: "syncreq_1",
        pendingCount: 2,
        requestedAt: "2026-10-16T09:00:00.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 5,
      },
      {
        request,
        activeBusinessId: "biz-active",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 5,
        flushImpl,
      },
    );
    expect(tenantMismatch.accepted).toBe(false);
    expect(tenantMismatch.reason).toBe("tenant_mismatch");

    // 2. Installation mismatch
    const installMismatch = await reconcileNativeSyncRequest(
      {
        businessId: "biz-active",
        syncRequestId: "syncreq_2",
        pendingCount: 2,
        requestedAt: "2026-10-16T09:00:00.000Z",
        installationId: "inst-other-device",
        sessionGeneration: 5,
      },
      {
        request,
        activeBusinessId: "biz-active",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 5,
        flushImpl,
      },
    );
    expect(installMismatch.accepted).toBe(false);
    expect(installMismatch.reason).toBe("installation_mismatch");

    // 3. Session generation mismatch
    const genMismatch = await reconcileNativeSyncRequest(
      {
        businessId: "biz-active",
        syncRequestId: "syncreq_3",
        pendingCount: 2,
        requestedAt: "2026-10-16T09:00:00.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 4,
      },
      {
        request,
        activeBusinessId: "biz-active",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 5,
        flushImpl,
      },
    );
    expect(genMismatch.accepted).toBe(false);
    expect(genMismatch.reason).toBe("session_generation_mismatch");

    // 4. Duplicate request ID
    const duplicate = await reconcileNativeSyncRequest(
      {
        businessId: "biz-active",
        syncRequestId: "syncreq_already_done",
        pendingCount: 2,
        requestedAt: "2026-10-16T09:00:00.000Z",
        installationId: "inst-alpha-1234567890",
        sessionGeneration: 5,
      },
      {
        request,
        activeBusinessId: "biz-active",
        activeInstallationId: "inst-alpha-1234567890",
        activeSessionGeneration: 5,
        acknowledgedRequestIds: acknowledgedIds,
        flushImpl,
      },
    );
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe("duplicate_or_stale");

    expect(flushImpl).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("reconciles durable waiting_for_app state when the browser reopens after a closed-app background health probe", async () => {
    const v3Snapshot: NativeRuntimeSnapshot = {
      kind: "android-twa",
      connection: "connected",
      androidPackage: "com.bizamiz.app",
      environment: "production",
      app: {
        appVersionName: "1.2.0",
        appVersionCode: 12,
        environment: "production",
        bridgeVersion: 3,
        capabilities: ["notifications", "background.sync"],
      },
    };

    const calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
    const request = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
      calls.push({ command, payload });
      if (command === "device.identity") {
        return { installationId: "inst-reopen-1234567890" };
      }
      if (command === "sync.status") {
        return {
          scheduled: true,
          state: "waiting_for_app",
          waitingForApp: true,
          networkAvailable: true,
          businessId: "biz-1",
          pendingCount: 2,
          lastSyncedAt: null,
          pendingSyncRequestId: "syncreq_closed_browser_1",
          installationId: "inst-reopen-1234567890",
          sessionGeneration: 9,
          revoked: false,
        };
      }
      if (command === "sync.acknowledge") {
        return {
          accepted: true,
          reason: "acknowledged",
          businessId: "biz-1",
          syncRequestId: "syncreq_closed_browser_1",
          flushedCount: 0,
          remainingCount: 0,
          lastSyncedAt: null,
          state: "idle",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    }) as unknown as NativeRequest;

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ device: { sessionGeneration: 9 } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(v3Snapshot, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar businessId="biz-1" />
      </NativeValueProvider>,
    );

    await waitFor(() =>
      expect(calls.some((c) => c.command === "sync.acknowledge")).toBe(true),
    );
    const ackCall = calls.find((c) => c.command === "sync.acknowledge");
    expect(ackCall?.payload).toMatchObject({
      businessId: "biz-1",
      syncRequestId: "syncreq_closed_browser_1",
      installationId: "inst-reopen-1234567890",
      sessionGeneration: 9,
    });
  });
});

