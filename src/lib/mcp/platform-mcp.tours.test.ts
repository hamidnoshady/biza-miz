import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTours: vi.fn(),
  getTour: vi.fn(),
  listRevisions: vi.fn(),
  saveTour: vi.fn(),
  publishTour: vi.fn(),
  rollbackTour: vi.fn(),
  archiveTour: vi.fn(),
  deleteDraft: vi.fn(),
  audit: vi.fn(async (_entry: { businessId?: string | null; payload?: Record<string, unknown> }) => {}),
}));

vi.mock("../db", () => ({
  query: vi.fn(),
  withoutTenantScope: (_reason: string, work: () => unknown) => work(),
}));

vi.mock("../platform-auth", () => ({ platformAudit: mocks.audit }));

vi.mock("../tour-studio-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tour-studio-service")>();
  return {
    ...actual,
    listStudioTours: mocks.listTours,
    getStudioTour: mocks.getTour,
    listStudioTourRevisions: mocks.listRevisions,
    saveStudioTour: mocks.saveTour,
    publishStudioTour: mocks.publishTour,
    rollbackStudioTour: mocks.rollbackTour,
    archiveStudioTour: mocks.archiveTour,
    deleteStudioTourDraft: mocks.deleteDraft,
  };
});

import {
  callPlatformMcpTool,
  platformMcpToolCatalogue,
  type PlatformMcpConnection,
} from "./platform-mcp";

const connection: PlatformMcpConnection = {
  id: "connection-1",
  adminId: "admin-1",
  adminName: "Admin",
  adminRole: "owner",
  name: "ChatGPT",
  origin: "token",
  capabilities: ["knowledge.manage"],
  businessIds: null,
  status: "active",
  lastUsedAt: null,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("platform MCP guided-tour management", () => {
  it("lists authored tours for a knowledge.manage connection", async () => {
    const tours = [{ id: "tour-row-1", tourKey: "studio.crm.audit", status: "draft" }];
    mocks.listTours.mockResolvedValue(tours);

    const catalogue = platformMcpToolCatalogue(connection);
    expect(catalogue.map((tool) => tool.name)).toContain("list_guided_tours");

    const result = await callPlatformMcpTool(connection, "list_guided_tours", {});

    expect(result.data).toEqual({ tours });
    expect(mocks.listTours).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ tool: "list_guided_tours", outcome: "ok" }),
    }));
  });

  it("exposes and dispatches every Studio lifecycle operation", async () => {
    const names = platformMcpToolCatalogue(connection).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "get_guided_tour_authoring_options",
      "get_guided_tour",
      "save_guided_tour",
      "publish_guided_tour",
      "rollback_guided_tour",
      "archive_guided_tour",
      "delete_draft_guided_tour",
    ]));

    const tour = { id: "tour-row-1", tourKey: "studio.crm.audit", version: 2 };
    mocks.getTour.mockResolvedValue(tour);
    mocks.listRevisions.mockResolvedValue([{ version: 2, live: false }]);
    mocks.saveTour.mockResolvedValue({ id: tour.id, version: 3, created: false });
    mocks.publishTour.mockResolvedValue(tour);
    mocks.rollbackTour.mockResolvedValue(tour);
    mocks.archiveTour.mockResolvedValue(tour);
    mocks.deleteDraft.mockResolvedValue(undefined);

    const content = {
      tourKey: "studio.crm.audit",
      pageKey: "page:/crm/audit",
      title: "سابقهٔ تصمیم‌ها",
      description: "",
      eligibility: {},
      steps: [
        { id: "intro", kind: "explain", title: "شروع", body: "." },
        { id: "header", kind: "spotlight", anchor: "page.header", title: "سرصفحه", body: "." },
      ],
    };

    expect((await callPlatformMcpTool(connection, "get_guided_tour", { tourId: tour.id })).data)
      .toEqual({ tour, revisions: [{ version: 2, live: false }] });
    expect((await callPlatformMcpTool(connection, "save_guided_tour", {
      record: content,
      expectedVersion: 2,
    })).data).toEqual({ ok: true, id: tour.id, version: 3, created: false });
    expect((await callPlatformMcpTool(connection, "publish_guided_tour", {
      tourId: tour.id,
      version: 2,
    })).data).toEqual({ ok: true, tour });
    expect((await callPlatformMcpTool(connection, "rollback_guided_tour", {
      tourId: tour.id,
      toVersion: 1,
    })).data).toEqual({ ok: true, tour });
    expect((await callPlatformMcpTool(connection, "archive_guided_tour", { tourId: tour.id })).data)
      .toEqual({ ok: true, tour });
    expect((await callPlatformMcpTool(connection, "delete_draft_guided_tour", { tourId: tour.id })).data)
      .toEqual({ ok: true, id: tour.id });

    // The tour row id belongs in the payload, never in `business_id`: that
    // column is a foreign key into `businesses`, so a tour id there made every
    // one of these audit writes fail on 23503 and reach the log unattributed.
    for (const call of mocks.audit.mock.calls) {
      expect(call[0].businessId ?? null).toBeNull();
    }
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      businessId: null,
      payload: expect.objectContaining({ action: "knowledge_tour.publish", tourId: tour.id }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      businessId: null,
      payload: expect.objectContaining({ action: "knowledge_tour.delete_draft", tourId: tour.id }),
    }));

    expect(mocks.saveTour).toHaveBeenCalledWith(expect.objectContaining({ tourKey: content.tourKey }), "admin-1", 2);
    expect(mocks.publishTour).toHaveBeenCalledWith(tour.id, "admin-1", 2);
    expect(mocks.rollbackTour).toHaveBeenCalledWith(tour.id, 1, "admin-1");
    expect(mocks.archiveTour).toHaveBeenCalledWith(tour.id, "admin-1");
    expect(mocks.deleteDraft).toHaveBeenCalledWith(tour.id);
  });

  it("provides the canonical page, anchor and eligibility catalogues used by validation", async () => {
    const result = await callPlatformMcpTool(connection, "get_guided_tour_authoring_options", {});
    const options = result.data as {
      pages: Array<{ key: string; route: string }>;
      anchors: string[];
      templates: Array<{ id: string }>;
      industries: string[];
      permissions: string[];
    };

    expect(options.pages).toContainEqual(expect.objectContaining({ key: "page:/crm/audit", route: "/crm/audit" }));
    expect(options.anchors).toContain("page.header");
    expect(options.templates.map((template) => template.id)).toContain("standard-intro");
    expect(options.industries.length).toBeGreaterThan(0);
    expect(options.permissions).toContain("crm.view");
  });

  it("rejects invalid tour content and optimistic versions before saving", async () => {
    await expect(callPlatformMcpTool(connection, "save_guided_tour", {
      record: { tourKey: "valid.key" },
      expectedVersion: 0,
    })).rejects.toThrow("expectedVersion must be a positive integer");
    await expect(callPlatformMcpTool(connection, "save_guided_tour", {
      record: { tourKey: "baseline.invalid" },
    })).rejects.toThrow("baseline_key_reserved");

    expect(mocks.saveTour).not.toHaveBeenCalled();
  });

  it("does not expose or execute tour tools without knowledge.manage", async () => {
    const readOnly = { ...connection, capabilities: ["system.read"] } as PlatformMcpConnection;
    mocks.listTours.mockResolvedValue([]);

    expect(platformMcpToolCatalogue(readOnly).map((tool) => tool.name)).not.toContain("list_guided_tours");
    const result = await callPlatformMcpTool(readOnly, "list_guided_tours", {});

    expect(result.text).toContain("denied");
    expect(mocks.listTours).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ tool: "list_guided_tours", outcome: "denied_capability" }),
    }));
  });
});
