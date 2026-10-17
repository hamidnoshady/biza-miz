import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { boundedPullWaitSeconds, MAX_PULL_WAIT_SECONDS, SYNC_PULL_MARKER_HEADER } from "@/lib/sync-watch";

type AnyFn = ReturnType<typeof vi.fn>;

/**
 * Issue #989 — the server half of the wake-up long-poll.
 *
 * The desktop's watcher can only tell "the app refused this" from "an edge
 * killed the hold" if every answer the app writes is marked. These tests pin
 * that marker (and `no-store`, so no intermediary caches a `pending:false`)
 * on both the refusal it writes before any database read and the peek answer
 * it writes after one. They also pin the hold ceiling: the route must never
 * hold longer than the constant the watcher's deadline is built around.
 */
const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  resolveSyncCredential: vi.fn() as AnyFn,
  recordSyncRun: vi.fn(async () => {}) as AnyFn,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withTenant: async (_id: string, fn: () => Promise<unknown>) => fn(),
  withoutTenantScope: async (_who: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/server-sync", () => ({
  resolveSyncCredential: mocks.resolveSyncCredential,
  recordLegacyTokenUsage: vi.fn(async () => {}),
  recordSyncRun: mocks.recordSyncRun,
  tokensMatch: () => false,
  legacySyncToken: () => null,
}));

import { GET } from "./route";

const CREDENTIAL = { businessId: "biz-1", locationId: null, siteDeviceId: "device-1" };

function request(query: string, token: string | null = "site-token") {
  return new NextRequest(`https://central.example/api/server-sync/pull${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("GET /api/server-sync/pull", () => {
  it("marks even the answer it writes before reading the database", async () => {
    mocks.resolveSyncCredential.mockResolvedValue(null);
    const response = await GET(request("?peek=1&wait=0", null));
    expect(response.status).toBe(401);
    expect(response.headers.get(SYNC_PULL_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks an idle peek and never caches it", async () => {
    mocks.resolveSyncCredential.mockResolvedValue(CREDENTIAL);
    const response = await GET(request("?peek=1&wait=0&after=0&afterTx=0"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending: false });
    expect(response.headers.get(SYNC_PULL_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a waiting event to a peek without returning it", async () => {
    mocks.resolveSyncCredential.mockResolvedValue(CREDENTIAL);
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "7",
          txid: "900",
          location_id: "loc-1",
          client_event_id: "ce-7",
          event_type: "order.create",
          payload: {},
          occurred_at: new Date("2026-10-17T08:00:00Z"),
          actor_user_id: null,
          actor_role: null,
          site_device_id: null,
          schema_version: 1,
        },
      ],
    });
    const response = await GET(request("?peek=1&wait=0&after=0&afterTx=0"));
    expect(await response.json()).toEqual({ pending: true });
    expect(mocks.recordSyncRun).not.toHaveBeenCalled();
  });

  it("caps the hold below an edge's idle timeout, whatever the caller asks", () => {
    // The route delegates its bound to this pure policy helper.
    expect(MAX_PULL_WAIT_SECONDS).toBeLessThan(30);
    expect(boundedPullWaitSeconds("25")).toBe(20);
    expect(boundedPullWaitSeconds("120")).toBe(20);
  });
});
