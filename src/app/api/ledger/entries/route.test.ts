import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

const SESSION = { businessId: "biz-1" };
const ENTRY_ID = "00000000-0000-4000-8000-000000000001";

function request(queryString: string) {
  return { nextUrl: new URL(`http://localhost/api/ledger/entries${queryString}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("GET /api/ledger/entries exact-entry drill-down", () => {
  it("filters by one journal entry id in the tenant-scoped query", async () => {
    const response = await GET(request(`?entryId=${ENTRY_ID}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], hasMore: false });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("AND ($6::uuid IS NULL OR je.id = $6::uuid)");
    expect(values).toEqual(["biz-1", null, null, null, null, ENTRY_ID, 101, 0]);
  });

  it("rejects malformed exact-entry identifiers before querying", async () => {
    const response = await GET(request("?entryId=not-a-uuid"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_entry_id" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses the calendar-aware ISO validation for its accounting date filters", async () => {
    const response = await GET(request("?dateFrom=2025-02-31"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_date" });
    expect(db.query).not.toHaveBeenCalled();
  });
});
