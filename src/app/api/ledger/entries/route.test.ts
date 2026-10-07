/**
 * Issue #821 — `GET /api/ledger/entries`, the journal's one read route.
 *
 * What it must hold: `ledger.view` is the door, every unusable parameter is a
 * named 400 (an impossible calendar date especially — it used to reach
 * PostgreSQL's `::date` cast as a 500), the page is addressed by cursor rather
 * than offset, and `?format=` exports the *complete filtered result* through
 * the same filters, not the rows that happen to be loaded.
 *
 * The service it delegates to is DB-touching and therefore mocked; what is
 * asserted here is the contract between the HTTP layer and that service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as journalService from "@/lib/journal-service";
import { encodeJournalCursor, JOURNAL_PAGE_SIZE } from "@/lib/journal-filters";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/journal-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/journal-service")>();
  return { ...actual, listJournalEntries: vi.fn(), listJournalEntriesForExport: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

const EMPTY_PAGE = { entries: [], hasMore: false, nextCursor: null, totalCount: 0 };

function request(qs = "") {
  return { nextUrl: new URL(`http://localhost:3000/api/ledger/entries${qs}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(journalService.listJournalEntries).mockResolvedValue(EMPTY_PAGE as never);
  vi.mocked(journalService.listJournalEntriesForExport).mockResolvedValue({
    entries: [],
    truncated: false,
  } as never);
});

describe("GET /api/ledger/entries — the permission door", () => {
  it("asks for ledger.view", async () => {
    await GET(request());
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("ledger.view");
  });

  it("returns the guard's own refusal without touching the journal", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(journalService.listJournalEntries).not.toHaveBeenCalled();
  });
});

describe("GET /api/ledger/entries — parameter validation", () => {
  it("rejects an impossible calendar date with a controlled 400", async () => {
    const res = await GET(request("?dateFrom=2026-02-31"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_date" });
    expect(journalService.listJournalEntries).not.toHaveBeenCalled();
  });

  it("rejects a malformed date", async () => {
    expect((await GET(request("?dateTo=banana"))).status).toBe(400);
  });

  it("accepts a leap day", async () => {
    expect((await GET(request("?dateFrom=2024-02-29"))).status).toBe(200);
  });

  it("rejects an inverted date range by name", async () => {
    const res = await GET(request("?dateFrom=2026-05-01&dateTo=2026-04-01"));
    expect(await res.json()).toEqual({ error: "invalid_date_range" });
  });

  it("rejects an unusable filter rather than silently dropping it", async () => {
    expect(await (await GET(request("?location=not-a-uuid"))).json()).toEqual({ error: "invalid_filter" });
    expect(await (await GET(request("?reversal=maybe"))).json()).toEqual({ error: "invalid_filter" });
    expect(await (await GET(request("?amountMin=1.5"))).json()).toEqual({ error: "invalid_amount" });
    expect(await (await GET(request("?cursor=tampered"))).json()).toEqual({ error: "invalid_cursor" });
    expect(await (await GET(request("?format=pdf"))).json()).toEqual({ error: "invalid_format" });
  });
});

describe("GET /api/ledger/entries — the page", () => {
  it("passes every filter through to the journal service", async () => {
    const ids = {
      location: "11111111-1111-4111-8111-111111111111",
      account: "22222222-2222-4222-8222-222222222222",
      creator: "33333333-3333-4333-8333-333333333333",
      project: "44444444-4444-4444-8444-444444444444",
    };
    await GET(
      request(
        `?dateFrom=2026-01-01&dateTo=2026-03-31&sourceType=manual&q=rent` +
          `&location=${ids.location}&account=${ids.account}&creator=${ids.creator}&project=${ids.project}` +
          `&reversal=reversed&kind=manual&amountMin=100&amountMax=900`,
      ),
    );
    const [businessId, filters] = vi.mocked(journalService.listJournalEntries).mock.calls[0];
    expect(businessId).toBe("biz-1");
    expect(filters).toMatchObject({
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
      sourceType: "manual",
      q: "rent",
      locationId: ids.location,
      accountId: ids.account,
      createdBy: ids.creator,
      projectId: ids.project,
      reversalState: "reversed",
      entryKind: "manual",
      amountMin: "100",
      amountMax: "900",
      limit: JOURNAL_PAGE_SIZE,
      cursor: null,
    });
  });

  it("forwards a cursor as the decoded ordering tuple — no offset anywhere", async () => {
    const cursor = {
      entryDate: "2026-02-14",
      postedAt: "2026-02-14T09:30:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    };
    await GET(request(`?cursor=${encodeURIComponent(encodeJournalCursor(cursor))}`));
    expect(vi.mocked(journalService.listJournalEntries).mock.calls[0][1].cursor).toEqual(cursor);
  });

  it("returns the page exactly as the service shaped it, including the real total", async () => {
    vi.mocked(journalService.listJournalEntries).mockResolvedValue({
      entries: [],
      hasMore: true,
      nextCursor: "2026-02-14|2026-02-14T09:30:00.000Z|55555555-5555-4555-8555-555555555555",
      totalCount: 1203,
    } as never);
    const res = await GET(request());
    expect(await res.json()).toMatchObject({ hasMore: true, totalCount: 1203 });
  });
});

describe("GET /api/ledger/entries — export", () => {
  it("exports the complete filtered result, not the loaded page", async () => {
    await GET(request("?format=csv&sourceType=manual&limit=5"));
    expect(journalService.listJournalEntries).not.toHaveBeenCalled();
    const [, filters] = vi.mocked(journalService.listJournalEntriesForExport).mock.calls[0];
    expect(filters.sourceType).toBe("manual");
  });

  it("answers CSV as a download", async () => {
    const res = await GET(request("?format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("journal.csv");
  });

  it("answers XLSX as a download", async () => {
    const res = await GET(request("?format=xlsx"));
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(res.headers.get("Content-Disposition")).toContain("journal.xlsx");
  });

  it("says so when the export hit its row cap instead of handing over a silently short file", async () => {
    vi.mocked(journalService.listJournalEntriesForExport).mockResolvedValue({
      entries: [],
      truncated: true,
    } as never);
    const res = await GET(request("?format=csv"));
    expect(res.headers.get("X-Journal-Export-Truncated")).toBeTruthy();
  });
});
