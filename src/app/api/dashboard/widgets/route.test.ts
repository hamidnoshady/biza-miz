import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as reportsService from "@/lib/reports-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (h: (...args: unknown[]) => Promise<Response>) => h,
  };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return {
    ...actual,
    getDashboardWidgets: vi.fn(async () => ({ scope: "personal", widgets: [], revision: "rev-1" })),
    saveDashboardWidgets: vi.fn(async () => ({ ok: true, revision: "rev-2" })),
    appendDashboardWidget: vi.fn(async () => ({
      ok: true,
      revision: "rev-2",
      widget: { savedReportId: "report-1", chartType: "bar", title: "فروش", x: 0, y: 3, w: 4, h: 3 },
    })),
    savedReportIdsInBusiness: vi.fn(async () => ({ owned: new Set(["report-1"]), applicable: new Set(["report-1"]) })),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const WIDGET = {
  savedReportId: "report-1",
  chartType: "bar" as const,
  title: "فروش",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
    owned: new Set(["report-1"]),
    applicable: new Set(["report-1"]),
  } as never);
});

describe("GET /api/dashboard/widgets", () => {
  it("reads on the report-view capability", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
  });

  it("returns the layout's revision so a client can write against what it read", async () => {
    // Without this the browser had no version to quote and every whole-layout
    // write was "whatever I last saw" — the read-modify-write race of #819.
    const response = await GET();
    await expect(response.json()).resolves.toEqual({ scope: "personal", widgets: [], revision: "rev-1" });
  });
});

describe("POST /api/dashboard/widgets — personal layout", () => {
  it("needs only the read capability, and writes the caller's own layout", async () => {
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET] }));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls.map((c) => c[0])).toEqual(["reports.view"]);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1" },
      [expect.objectContaining({ savedReportId: "report-1" })],
      { ifRevision: undefined, preserveInapplicableSavedReportIds: [] },
    );
  });

  it("passes the revision the client read, and answers with the new one", async () => {
    const response = await POST(
      postRequest({ scope: "personal", widgets: [WIDGET], ifRevision: "rev-1" }),
    );
    expect(response.status).toBe(200);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1" },
      expect.any(Array),
      { ifRevision: "rev-1", preserveInapplicableSavedReportIds: [] },
    );
    await expect(response.json()).resolves.toEqual({ ok: true, revision: "rev-2" });
  });

  it("answers 409 instead of overwriting a layout that changed under the client", async () => {
    vi.mocked(reportsService.saveDashboardWidgets).mockResolvedValueOnce({ ok: false, reason: "layout_changed" } as never);
    const response = await POST(
      postRequest({ scope: "personal", widgets: [WIDGET], ifRevision: "stale-rev" }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "layout_changed" });
  });

  it("refuses an unknown report before the layout is touched", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set(),
      applicable: new Set(),
    } as never);
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET], ifRevision: "rev-1" }));
    expect(response.status).toBe(400);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("refuses a new report that the current trade or engine cannot run", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set(["report-1"]),
      applicable: new Set(),
    } as never);
    const response = await POST(postRequest({
      scope: "personal",
      append: { savedReportId: "report-1", chartType: "bar", title: "گزارش صنف دیگر" },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "saved_report_not_applicable" });
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
  });

  it("lets the transaction preserve an old inapplicable tile only if it is still present", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set(["report-1"]),
      applicable: new Set(),
    } as never);
    vi.mocked(reportsService.saveDashboardWidgets).mockResolvedValueOnce({
      ok: false,
      reason: "saved_report_not_applicable",
    } as never);
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      ifRevision: "rev-1",
    }));
    expect(response.status).toBe(400);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1" },
      [expect.objectContaining({ savedReportId: "report-1" })],
      { ifRevision: "rev-1", preserveInapplicableSavedReportIds: ["report-1"] },
    );
  });

  it("refuses a report id that does not belong to this business", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set(),
      applicable: new Set(),
    } as never);
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unknown_saved_report" });
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("rejects a malformed widget before touching the database", async () => {
    const response = await POST(
      postRequest({ scope: "personal", widgets: [{ ...WIDGET, chartType: "donut" }] }),
    );
    expect(response.status).toBe(400);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/widgets — role default layout", () => {
  it("requires the elevated role-defaults capability (issue #819)", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await POST(postRequest({ scope: "role", role: "manager", widgets: [WIDGET] }));
    expect(response.status).toBe(403);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("writes the role layout when the capability is held", async () => {
    const response = await POST(postRequest({ scope: "role", role: "manager", widgets: [WIDGET] }));
    expect(response.status).toBe(200);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { role: "manager" },
      expect.any(Array),
      { ifRevision: undefined, preserveInapplicableSavedReportIds: [] },
    );
  });

  it("accepts every canonical role, including admin and accountant", async () => {
    // The route used to carry its own list that predated both roles, so those
    // two could never have a default layout (issue #819).
    for (const role of ["admin", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const response = await POST(postRequest({ scope: "role", role, widgets: [WIDGET] }));
      expect(response.status, role).toBe(200);
    }
  });

  it("rejects an unknown role name", async () => {
    const response = await POST(postRequest({ scope: "role", role: "supervisor", widgets: [WIDGET] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_role" });
  });
});

/**
 * The pin path (issue #819).
 *
 * Pinning used to be a browser-side read-modify-write: GET the layout, append a
 * tile at a row the client computed, POST the whole array back. A failed GET
 * read as an empty layout (`{error: …}.widgets ?? []`), so the POST replaced the
 * member's dashboard with one tile; and two pins racing each other each wrote
 * \"what I read, plus mine\", so the second write deleted the first.
 *
 * The server now owns the append. These tests pin down the contract the button
 * depends on: one request, no client-computed geometry, server validation of the
 * report id, and a revision on the way out.
 */
describe("POST /api/dashboard/widgets — append one pin", () => {
  it("appends through the service rather than replacing the layout", async () => {
    const response = await POST(
      postRequest({ scope: "personal", append: { savedReportId: "report-1", chartType: "bar", title: "فروش" } }),
    );

    expect(response.status).toBe(200);
    expect(reportsService.appendDashboardWidget).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1" },
      expect.objectContaining({ savedReportId: "report-1", chartType: "bar", title: "فروش" }),
    );
    // The whole-layout replace must not run at all: that is the operation that
    // could delete a concurrent write.
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      revision: "rev-2",
      widget: expect.objectContaining({ savedReportId: "report-1", y: 3 }),
    });
  });

  it("does not forward a client-computed placement to the service", async () => {
    // A single pin has no business choosing its row: the server reads the
    // current layout under a lock and places the tile. A `y` from the browser
    // would be a guess about a layout it read at some unknown earlier time.
    await POST(
      postRequest({
        scope: "personal",
        // Sent by a client that still believes it owns the layout.
        append: { savedReportId: "report-1", chartType: "bar", title: "فروش", x: 99, y: 99, w: 12, h: 9 },
      }),
    );
    const placement = vi.mocked(reportsService.appendDashboardWidget).mock.calls[0][2];
    expect(placement).toMatchObject({ savedReportId: "report-1", chartType: "bar", w: 12, h: 9 });
    expect(placement).not.toHaveProperty("x");
    expect(placement).not.toHaveProperty("y");
  });

  it("validates the report id before appending", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set(),
      applicable: new Set(),
    } as never);
    const response = await POST(
      postRequest({ scope: "personal", append: { savedReportId: "someone-elses", chartType: "bar", title: "x" } }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unknown_saved_report" });
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
  });

  it("refuses an unknown chart type", async () => {
    const response = await POST(
      postRequest({ scope: "personal", append: { savedReportId: "report-1", chartType: "donut", title: "x" } }),
    );
    expect(response.status).toBe(400);
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
  });

  it("needs the elevated capability to append into a role's default layout", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await POST(
      postRequest({ scope: "role", role: "manager", append: { savedReportId: "report-1", chartType: "bar", title: "x" } }),
    );
    expect(response.status).toBe(403);
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
  });
});
