/**
 * The dimension master's HTTP contract (issue #868).
 *
 * Reading is `ledger.view`; writing is `accounts.edit`, the chart's own key. A
 * write body that is not an object is refused before the service is reached, and
 * an unknown kind is refused by name. The rules themselves are covered by
 * `src/lib/accounting-dimensions.test.ts` and the database by
 * integration/accounting-dimensions.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as dims from "@/lib/accounting-dimensions-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/accounting-dimensions-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounting-dimensions-service")>();
  return {
    ...actual,
    listDimensionSettings: vi.fn(async () => []),
    listDimensionValues: vi.fn(async () => []),
    createDimensionValue: vi.fn(async () => ({ id: "new" })),
  };
});

const SESSION = { businessId: "business-1", sub: "user-1" };

function get(qs = ""): NextRequest {
  return { nextUrl: new URL(`http://localhost:3000/api/ledger/dimensions${qs}`) } as unknown as NextRequest;
}

function post(body: unknown): NextRequest {
  return {
    json: async () => body,
    nextUrl: new URL("http://localhost:3000/api/ledger/dimensions"),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/ledger/dimensions", () => {
  it("reads on ledger.view", async () => {
    await GET(get());
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
  });

  it("refuses an unknown kind filter by name", async () => {
    const response = await GET(get("?kind=project"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown_dimension_kind" });
    expect(dims.listDimensionValues).not.toHaveBeenCalled();
  });

  it("hides archived values unless asked for", async () => {
    await GET(get());
    expect(dims.listDimensionValues).toHaveBeenLastCalledWith("business-1", { kind: undefined, includeArchived: false });
    await GET(get("?includeArchived=1&kind=cost_center"));
    expect(dims.listDimensionValues).toHaveBeenLastCalledWith("business-1", { kind: "cost_center", includeArchived: true });
  });
});

describe("POST /api/ledger/dimensions", () => {
  it("writes on accounts.edit, the chart's key, and not on the ledger's", async () => {
    await POST(post({ kind: "cost_center", code: "CC-1", name: "Centre" }));
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.accountsEdit);
  });

  it("refuses a body that is not an object before the service is reached", async () => {
    const response = await POST(post(["not", "an", "object"]));
    expect(response.status).toBe(400);
    expect(dims.createDimensionValue).not.toHaveBeenCalled();
  });

  it("passes the record through and answers 201", async () => {
    const response = await POST(
      post({ kind: "cost_center", code: "CC-1", name: "Centre", effectiveFrom: "2026-10-01", isActive: false }),
    );
    expect(response.status).toBe(201);
    expect(dims.createDimensionValue).toHaveBeenCalledWith("business-1", "user-1", {
      kind: "cost_center",
      code: "CC-1",
      name: "Centre",
      parentId: null,
      locationId: null,
      effectiveFrom: "2026-10-01",
      effectiveTo: null,
      isActive: false,
    });
  });
});
