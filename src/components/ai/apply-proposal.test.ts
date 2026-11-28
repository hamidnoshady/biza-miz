// GH #1567 F7 — the browser has exactly one way to apply a proposal: the
// audited apply route, carrying the approval hash the card displayed. A card
// with no audit link is refused instead of calling the destination directly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProposalRequest } from "./apply-proposal";

const proposal = { type: "ar.receipt.record", title: "دریافت", summary: "دریافت نقدی", payload: { customerId: "c1", method: "cash", amount: 100 } } as never;

afterEach(() => vi.unstubAllGlobals());

describe("applyProposalRequest (GH #1567 F7)", () => {
  it("refuses a proposal without an audit link and never calls any endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyProposalRequest(proposal, null);
    expect(outcome.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the audit id and the displayed hash to the audited apply route only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ endpoint: "/api/ar/receipts" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const hash = "b".repeat(64);
    const outcome = await applyProposalRequest(proposal, "audit-1", undefined, hash);
    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/proposals/apply");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ auditId: "audit-1", payloadHash: hash });
  });

  it("surfaces the server's refusal (e.g. a stale screen) without retrying elsewhere", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "approval_stale", message: "صفحه را تازه کنید" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyProposalRequest(proposal, "audit-1", undefined, "c".repeat(64));
    expect(outcome).toMatchObject({ ok: false, detail: "صفحه را تازه کنید" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
