/**
 * Issue #821 — `POST /api/ledger/entries/[id]/reverse`.
 *
 * Reversal is the journal's one destructive action, so the route's job is
 * narrow and worth pinning: `ledger.approve` and nothing less, and the memo
 * and date the confirmation dialog collects forwarded verbatim.
 *
 * The approver's active location is still passed, but it is a fallback, not
 * the routing: the reversing journal and its sync event both belong to the
 * **original document's** branch, which only `reverseEntry` can know. Routing
 * by `resolveActiveLocation(session)` alone sent an accountant standing in
 * Branch B's reversal of a Branch A document to the wrong branch — that is
 * asserted where it is decided, in `manual-journal.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as manualJournal from "@/lib/manual-journal-service";
import { ManualJournalError, MANUAL_MEMO_MAX } from "@/lib/manual-journal-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/manual-journal-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manual-journal-service")>();
  return { ...actual, reverseEntry: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "accountant" };
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function postRequest(body: unknown, id = ENTRY_ID) {
  return [
    { json: async () => body } as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-b" } as never);
  vi.mocked(manualJournal.reverseEntry).mockResolvedValue({ entryId: "reversal-1" } as never);
});

describe("POST /api/ledger/entries/[id]/reverse", () => {
  it("requires ledger.approve, not merely ledger.view", async () => {
    await POST(...postRequest({}));
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("ledger.approve");
  });

  it("returns the guard's refusal without posting anything", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const res = await POST(...postRequest({}));
    expect(res.status).toBe(403);
    expect(manualJournal.reverseEntry).not.toHaveBeenCalled();
  });

  it("hands the approver's branch over as a fallback, never as the routing", async () => {
    await POST(...postRequest({}));
    // The route cannot know the original's branch — it does not read the
    // entry. All it may contribute is the last-resort queue for a document
    // that has no branch of its own; `reverseEntry` decides the rest.
    expect(vi.mocked(manualJournal.reverseEntry).mock.calls[0][0].locationId).toBe("loc-b");
  });

  it("passes null when the approver has no active branch, rather than inventing one", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    await POST(...postRequest({}));
    expect(vi.mocked(manualJournal.reverseEntry).mock.calls[0][0].locationId).toBeNull();
  });

  it("forwards the confirmation dialog's memo and date", async () => {
    await POST(...postRequest({ memo: "اشتباه در مبلغ", entryDate: "2026-03-01" }));
    expect(vi.mocked(manualJournal.reverseEntry).mock.calls[0][0]).toMatchObject({
      businessId: "biz-1",
      entryId: ENTRY_ID,
      actorId: "user-1",
      memo: "اشتباه در مبلغ",
      entryDate: "2026-03-01",
    });
  });

  it("accepts an empty body — memo and date are optional", async () => {
    const res = await POST({ json: async () => { throw new Error("no body"); } } as unknown as NextRequest, {
      params: Promise.resolve({ id: ENTRY_ID }),
    });
    expect(res.status).toBe(201);
  });

  it("answers a non-uuid id as «not found» instead of letting a cast error 500", async () => {
    const res = await POST(...postRequest({}, "not-a-uuid"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "entry_not_found" });
    expect(manualJournal.reverseEntry).not.toHaveBeenCalled();
  });

  it("bounds the reversal memo the way the draft memo is bounded", async () => {
    const res = await POST(...postRequest({ memo: "ب".repeat(MANUAL_MEMO_MAX + 1) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "memo_too_long" });
  });

  it("passes the service's own refusals through with their codes", async () => {
    vi.mocked(manualJournal.reverseEntry).mockRejectedValue(new ManualJournalError("already_reversed", 409));
    const res = await POST(...postRequest({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_reversed" });
  });

  it("answers a locked fiscal period as a 409 the dialog can explain", async () => {
    const lock = Object.assign(new Error("fiscal period locked"), { code: "P0001", message: "fiscal_period_locked" });
    vi.mocked(manualJournal.reverseEntry).mockRejectedValue(lock);
    const res = await POST(...postRequest({}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("fiscal_period_locked");
  });
});
