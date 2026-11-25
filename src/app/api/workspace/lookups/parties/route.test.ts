import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ owner: vi.fn(), search: vi.fn() }));

vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn }));
vi.mock("../../guard", () => ({
  PERMISSIONS: { workspaceView: "workspace.view" },
  workspaceOwner: m.owner,
  handleWorkspaceError: (err: unknown) => {
    throw err;
  },
}));
vi.mock("@/lib/workspace-lookups", () => ({
  normalizePartySearchTerm: (value: string | null) => (value ?? "").trim(),
  partyIdsFrom: (value: string | null) => (value ? value.split(",") : []),
  partyPageRequest: ({ page, pageSize }: { page: string | null; pageSize: string | null }) => ({
    page: Number(page) || 1,
    pageSize: Number(pageSize) || 25,
    offset: 0,
  }),
  emptyWorkspacePartyPage: (pageSize: number) => ({
    parties: [],
    selected: [],
    total: 0,
    page: 1,
    pageSize,
    hasMore: false,
  }),
  searchWorkspaceParties: m.search,
}));

import { GET } from "./route";

const PARTY_ID = "8b1f5f9e-0000-4000-8000-000000000001";

function request(query: string) {
  return new NextRequest(`http://test/api/workspace/lookups/parties${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.search.mockResolvedValue({
    parties: [{ id: PARTY_ID, name: "شرکت آلفا" }],
    selected: [],
    total: 1,
    page: 1,
    pageSize: 25,
    hasMore: false,
  });
});

describe("GET /api/workspace/lookups/parties (#907 F10)", () => {
  it("searches for a member who may record contracts without administering the workspace", async () => {
    m.owner.mockResolvedValue({
      owner: { businessId: "tenant", access: { canManage: false, canManageContracts: true } },
      error: null,
    });

    const response = await GET(request(`?q=%20آلفا%20&page=2&pageSize=10&ids=${PARTY_ID}`));
    const body = (await response.json()) as { parties: unknown[]; total: number };

    expect(response.status).toBe(200);
    expect(m.search).toHaveBeenCalledWith("tenant", {
      q: "آلفا",
      page: 2,
      pageSize: 10,
      ids: [PARTY_ID],
    });
    expect(body.total).toBe(1);
    expect(body.parties).toHaveLength(1);
  });

  it("answers a read-only member with an empty page and never reads the directory", async () => {
    m.owner.mockResolvedValue({
      owner: { businessId: "tenant", access: { canManage: false, canManageContracts: false } },
      error: null,
    });

    const response = await GET(request("?q=آلفا"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ parties: [], selected: [], total: 0 });
    expect(m.search).not.toHaveBeenCalled();
  });

  it("refuses an ineligible business through workspaceOwner (#1110) without searching", async () => {
    const refusal = NextResponse.json(
      { error: "workspace_unavailable", reason: "industry" },
      { status: 403 },
    );
    m.owner.mockResolvedValue({ owner: null, error: refusal });

    const response = await GET(request("?q=آلفا"));

    expect(response.status).toBe(403);
    expect(m.search).not.toHaveBeenCalled();
  });

  it("serves a workspace administrator too, with the same shape", async () => {
    m.owner.mockResolvedValue({
      owner: { businessId: "tenant", access: { canManage: true } },
      error: null,
    });

    const response = await GET(request(""));
    expect(response.status).toBe(200);
    expect(m.search).toHaveBeenCalledWith("tenant", {
      q: "",
      page: 1,
      pageSize: 25,
      ids: [],
    });
  });
});
