import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET } from "./route";

vi.mock("@/lib/db", () => ({
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
}));

const sessionMocks = vi.hoisted(() => ({
  session: {
    businessId: "biz-1",
    installationId: "inst-1",
    ticketId: "ticket-1",
    scope: ["repair.execute"],
  } as Record<string, unknown>,
  unauthorized: false,
}));

vi.mock("@/lib/support-companion/companion-auth", () => ({
  requireCompanionSession: vi.fn(async () =>
    sessionMocks.unauthorized
      ? { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) }
      : { session: sessionMocks.session },
  ),
}));

const catalogMocks = vi.hoisted(() => ({
  run: null as Record<string, unknown> | null,
  recipe: null as Record<string, unknown> | null,
  runThrows: false,
}));

vi.mock("@/lib/support-companion/repair-catalog", () => ({
  getRepairRun: vi.fn(async () => {
    if (catalogMocks.runThrows) throw new Error("bad uuid");
    return catalogMocks.run;
  }),
  getRecipe: vi.fn(async () => catalogMocks.recipe),
}));

// The route reads the id from params, never the URL — so malformed ids
// travel via params while the URL itself stays valid.
function request(paramRunId: string): { req: NextRequest; params: Promise<{ runId: string }> } {
  return {
    req: new NextRequest("http://localhost/api/support-companion/repairs/run"),
    params: Promise.resolve({ runId: paramRunId }),
  };
}

const RUN = {
  id: "11111111-1111-1111-1111-111111111111",
  businessId: "biz-1",
  ticketId: "ticket-1",
  installationId: "inst-1",
  recipeId: "companion.clean_temp",
  recipeVersion: 1,
  recipeHash: "ba74ad2b",
  state: "authorized",
};

const RECIPE = {
  recipeId: "companion.clean_temp",
  version: 1,
  risk: "low",
  compatibility: { platform: ["windows"] },
  preconditions: [],
  postchecks: [],
  backupPolicy: "none",
  recipe: { action: "companion.clean_temp", params: {} },
  recipeHash: "ba74ad2b",
};

describe("GET repairs/[runId] (issue #984 run fetch)", () => {
  it("returns the run plus its full recipe for a bound session", async () => {
    sessionMocks.unauthorized = false;
    catalogMocks.runThrows = false;
    catalogMocks.run = { ...RUN };
    catalogMocks.recipe = { ...RECIPE };
    const { req, params } = request("11111111-1111-1111-1111-111111111111");
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: unknown; recipe: unknown };
    expect(body.run).toMatchObject({ id: "11111111-1111-1111-1111-111111111111", state: "authorized" });
    expect(body.recipe).toMatchObject({ recipeId: "companion.clean_temp", version: 1 });
  });

  it("refuses without the repair.execute scope", async () => {
    sessionMocks.unauthorized = false;
    sessionMocks.session = { ...sessionMocks.session, scope: ["diagnostics.run"] };
    try {
      const { req, params } = request("11111111-1111-1111-1111-111111111111");
      const res = await GET(req, { params });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("scope_insufficient");
    } finally {
      sessionMocks.session = { ...sessionMocks.session, scope: ["repair.execute"] };
    }
  });

  it("passes auth failures through", async () => {
    sessionMocks.unauthorized = true;
    try {
      const { req, params } = request("11111111-1111-1111-1111-111111111111");
      const res = await GET(req, { params });
      expect(res.status).toBe(401);
    } finally {
      sessionMocks.unauthorized = false;
    }
  });

  it("returns a uniform not_found for misses and cross-ticket runs", async () => {
    sessionMocks.unauthorized = false;
    catalogMocks.runThrows = false;
    const { req, params } = request("99999999-9999-9999-9999-999999999999");

    catalogMocks.run = null;
    catalogMocks.recipe = { ...RECIPE };
    expect((await GET(req, { params })).status).toBe(404);

    catalogMocks.run = { ...RUN, ticketId: "ticket-other" };
    expect((await GET(req, { params })).status).toBe(404);

    catalogMocks.run = { ...RUN, installationId: "inst-other" };
    expect((await GET(req, { params })).status).toBe(404);

    catalogMocks.run = { ...RUN };
    catalogMocks.recipe = null;
    expect((await GET(req, { params })).status).toBe(404);
  });

  it("maps malformed ids and row errors to not_found, never 500", async () => {
    sessionMocks.unauthorized = false;
    const bad = request("not a uuid!!!");
    expect((await GET(bad.req, { params: bad.params })).status).toBe(404);

    catalogMocks.runThrows = true;
    try {
      const { req, params } = request("11111111-1111-1111-1111-111111111111");
      expect((await GET(req, { params })).status).toBe(404);
    } finally {
      catalogMocks.runThrows = false;
    }
  });
});
