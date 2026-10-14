import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as reportsService from "@/lib/reports-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return {
    ...actual,
    getDashboardWidgets: vi.fn(async () => ({
      scope: "role-default",
      widgets: [],
      precondition: {
        source: { scope: "role-default", revision: "role-rev-1" },
        target: { scope: "personal", revision: null },
      },
    })),
    getRoleDashboardWidgets: vi.fn(async () => ({
      scope: "role-default",
      widgets: [],
      precondition: {
        source: { scope: "role-default", revision: "role-rev-1" },
        target: { scope: "role-default", revision: "role-rev-1" },
      },
    })),
    saveDashboardWidgets: vi.fn(async () => ({
      ok: true,
      revision: "personal-rev-2",
      precondition: {
        source: { scope: "personal", revision: "personal-rev-2" },
        target: { scope: "personal", revision: "personal-rev-2" },
      },
    })),
    appendDashboardWidget: vi.fn(async () => ({
      ok: true,
      revision: "personal-rev-2",
      widget: { savedReportId: REPORT_ID, chartType: "bar", title: "فروش", x: 0, y: 3, w: 4, h: 3 },
    })),
    savedReportIdsInBusiness: vi.fn(async () => ({ owned: new Set([REPORT_ID]), applicable: new Set([REPORT_ID]) })),
  };
});

const REPORT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" as const };
const INHERITED_PRECONDITION = {
  source: { scope: "role-default" as const, revision: "role-rev-1" },
  target: { scope: "personal" as const, revision: null },
};
const PERSONAL_PRECONDITION = {
  source: { scope: "personal" as const, revision: "personal-rev-1" },
  target: { scope: "personal" as const, revision: "personal-rev-1" },
};
const ROLE_PRECONDITION = {
  source: { scope: "role-default" as const, revision: "role-rev-1" },
  target: { scope: "role-default" as const, revision: "role-rev-1" },
};

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/dashboard/widgets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(path = "/api/dashboard/widgets") {
  return new NextRequest(`http://localhost${path}`);
}

const WIDGET = {
  savedReportId: REPORT_ID,
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
    owned: new Set([REPORT_ID]),
    applicable: new Set([REPORT_ID]),
  } as never);
});

describe("GET /api/dashboard/widgets", () => {
  it("reads on reports.view and returns distinct source/target preconditions", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
    await expect(response.json()).resolves.toEqual({
      scope: "role-default",
      widgets: [],
      precondition: INHERITED_PRECONDITION,
    });
  });

  it("requires role-default management permission before reading another role's defaults", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await GET(getRequest("/api/dashboard/widgets?scope=role-default&role=manager"));
    expect(response.status).toBe(403);
    expect(reportsService.getRoleDashboardWidgets).not.toHaveBeenCalled();
  });

  it("reads the requested role layout when the dedicated capability is held", async () => {
    const response = await GET(getRequest("/api/dashboard/widgets?scope=role-default&role=accountant"));
    expect(response.status).toBe(200);
    expect(reportsService.getRoleDashboardWidgets).toHaveBeenCalledWith("biz-1", "accountant");
    await expect(response.json()).resolves.toMatchObject({
      precondition: ROLE_PRECONDITION,
    });
  });
});

describe("POST /api/dashboard/widgets — personal whole-layout replacement", () => {
  it("rejects non-object JSON bodies without throwing", async () => {
    for (const body of [null, [], "text", 17]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
    }
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("writes only the caller's personal layout and carries both revisions", async () => {
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: INHERITED_PRECONDITION,
    }));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0])).toEqual([
      "reports.view",
      "reports.manage",
    ]);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1", role: "manager" },
      [expect.objectContaining({ savedReportId: REPORT_ID })],
      INHERITED_PRECONDITION,
      { preserveInapplicableSavedReportIds: [] },
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      revision: "personal-rev-2",
      precondition: {
        source: { scope: "personal", revision: "personal-rev-2" },
        target: { scope: "personal", revision: "personal-rev-2" },
      },
    });
  });

  it("requires reports.manage before changing a personal layout", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await POST(postRequest({
      scope: "personal",
      append: { savedReportId: REPORT_ID, chartType: "bar" },
    }));
    expect(response.status).toBe(403);
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("requires preconditions; legacy direct clients cannot replace a layout unconditionally", async () => {
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET], ifRevision: "old-revision" }));
    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toEqual({ error: "precondition_required" });
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("requires both source and target revision properties, including an explicit null target", async () => {
    const missingSource = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: { target: { scope: "personal", revision: null } },
    }));
    expect(missingSource.status).toBe(428);

    const missingTargetRevision = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: { source: INHERITED_PRECONDITION.source, target: { scope: "personal" } },
    }));
    expect(missingTargetRevision.status).toBe(428);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("refuses inconsistent source/target semantics before the service is called", async () => {
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: {
        source: { scope: "role-default", revision: "role-rev-1" },
        target: { scope: "personal", revision: "unexpected-existing-layout" },
      },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_precondition" });
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("answers 409 instead of overwriting a layout changed since the source/target read", async () => {
    vi.mocked(reportsService.saveDashboardWidgets).mockResolvedValueOnce({ ok: false, reason: "layout_changed" } as never);
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: PERSONAL_PRECONDITION,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "layout_changed" });
  });

  it("refuses unknown and cross-business report ids before the layout is touched", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({ owned: new Set(), applicable: new Set() } as never);
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: INHERITED_PRECONDITION,
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unknown_saved_report" });
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("allows an inapplicable historical tile only when it is part of the inherited source", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue({
      owned: new Set([REPORT_ID]),
      applicable: new Set(),
    } as never);
    vi.mocked(reportsService.saveDashboardWidgets).mockResolvedValueOnce({
      ok: false,
      reason: "saved_report_not_applicable",
    } as never);
    const response = await POST(postRequest({
      scope: "personal",
      widgets: [WIDGET],
      precondition: INHERITED_PRECONDITION,
    }));
    expect(response.status).toBe(400);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1", role: "manager" },
      [expect.objectContaining({ savedReportId: REPORT_ID })],
      INHERITED_PRECONDITION,
      { preserveInapplicableSavedReportIds: [REPORT_ID] },
    );
  });

  it("rejects malformed widget shapes and grid geometry", async () => {
    for (const widget of [
      { ...WIDGET, chartType: "donut" },
      { ...WIDGET, x: 12, w: 4 },
      { ...WIDGET, w: 1 },
      null,
    ]) {
      const response = await POST(postRequest({
        scope: "personal",
        widgets: [widget],
        precondition: INHERITED_PRECONDITION,
      }));
      expect(response.status).toBe(400);
    }
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/widgets — role-default replacement", () => {
  it("requires reports.dashboard_defaults.manage", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await POST(postRequest({ scope: "role", role: "manager", widgets: [WIDGET], precondition: ROLE_PRECONDITION }));
    expect(response.status).toBe(403);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("writes the requested role layout only with role-default source and target revisions", async () => {
    const response = await POST(postRequest({
      scope: "role",
      role: "manager",
      widgets: [WIDGET],
      precondition: ROLE_PRECONDITION,
    }));
    expect(response.status).toBe(200);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { role: "manager" },
      expect.any(Array),
      ROLE_PRECONDITION,
      { preserveInapplicableSavedReportIds: [] },
    );
  });

  it("accepts every canonical role and rejects an unknown role name", async () => {
    for (const role of ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const response = await POST(postRequest({ scope: "role", role, widgets: [WIDGET], precondition: ROLE_PRECONDITION }));
      expect(response.status, role).toBe(200);
    }
    const invalid = await POST(postRequest({ scope: "role", role: "supervisor", widgets: [WIDGET], precondition: ROLE_PRECONDITION }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_role" });
  });
});

describe("POST /api/dashboard/widgets — atomic append", () => {
  it("appends through the service with no read-modify-write precondition", async () => {
    const response = await POST(postRequest({
      scope: "personal",
      append: { savedReportId: REPORT_ID, chartType: "bar", title: "فروش" },
    }));
    expect(response.status).toBe(200);
    expect(reportsService.appendDashboardWidget).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1", role: "manager" },
      expect.objectContaining({ savedReportId: REPORT_ID, chartType: "bar", title: "فروش" }),
    );
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      revision: "personal-rev-2",
      widget: expect.objectContaining({ savedReportId: REPORT_ID, y: 3 }),
    });
  });

  it("ignores client placement and rejects simultaneous append-and-replace", async () => {
    await POST(postRequest({
      append: { savedReportId: REPORT_ID, chartType: "bar", title: "فروش", x: 99, y: 99, w: 4, h: 3 },
    }));
    const placement = vi.mocked(reportsService.appendDashboardWidget).mock.calls[0][2];
    expect(placement).toMatchObject({ savedReportId: REPORT_ID, chartType: "bar", w: 4, h: 3 });
    expect(placement).not.toHaveProperty("x");
    expect(placement).not.toHaveProperty("y");

    const ambiguous = await POST(postRequest({
      append: { savedReportId: REPORT_ID, chartType: "bar" },
      widgets: [],
    }));
    expect(ambiguous.status).toBe(400);
  });

  it("validates the report and role-default permission before appending", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValueOnce({ owned: new Set(), applicable: new Set() } as never);
    const unknown = await POST(postRequest({ append: { savedReportId: REPORT_ID, chartType: "bar" } }));
    expect(unknown.status).toBe(400);
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();

    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);
    const denied = await POST(postRequest({
      scope: "role",
      role: "manager",
      append: { savedReportId: REPORT_ID, chartType: "bar" },
    }));
    expect(denied.status).toBe(403);
    expect(reportsService.appendDashboardWidget).not.toHaveBeenCalled();
  });
});
