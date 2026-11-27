// @vitest-environment jsdom
//
// GH #1567 C2 — a merge the server would refuse (e.g. live tailoring
// measurements on the record that would be archived) is explained in the
// preview and cannot be confirmed; a 409 from the server shows the same
// Persian message, never the raw code.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicatesSection, MERGE_BLOCKED_MESSAGE } from "./duplicates-section";

vi.mock("./today-queues", () => ({ CrmTodayQueues: () => null }));

const side = (id: string, name: string) => ({ id, name, phone: null, email: null, orderCount: 0, createdAt: "2026-11-01T00:00:00Z" });
let previewBlockers: { table: string; label: string; count: number }[] = [];
let mergeStatus = 200;
const posts: unknown[] = [];

beforeEach(() => {
  previewBlockers = [];
  mergeStatus = 200;
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/crm/customers/duplicates")) {
      return new Response(JSON.stringify({ duplicates: [{ reason: "phone", confidence: 90, left: side("p1", "سارا"), right: side("p2", "سارا ۲") }] }));
    }
    if (url.startsWith("/api/crm/customers/merge") && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return mergeStatus === 409
        ? new Response(JSON.stringify({ error: "party_merge_blocked", blockers: [] }), { status: 409 })
        : new Response(JSON.stringify({ merge: { winnerId: "p1", loserId: "p2", moved: {} } }));
    }
    if (url.startsWith("/api/crm/customers/merge")) {
      return new Response(JSON.stringify({ preview: {
        winner: { id: "p1", name: "سارا" }, loser: { id: "p2", name: "سارا ۲" }, moves: {}, moveLabels: {},
        resultingConsent: { smsConsent: false, marketingConsent: false }, resultingTags: [], blockers: previewBlockers,
      } }));
    }
    return new Response(JSON.stringify({ error: "not_mocked" }), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("customer merge refusals (GH #1567 C2)", () => {
  it("explains live measurements on the archived side and disables the merge", async () => {
    previewBlockers = [{ table: "tailoring_measurement_profiles", label: "اندازه‌های بدن (خیاطی)", count: 1 }];
    render(<DuplicatesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "نگه‌داشتن «سارا»" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(MERGE_BLOCKED_MESSAGE);
    expect(alert.textContent).toContain("اندازه‌های بدن (خیاطی)");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "ادغام نهایی" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toEqual([]);
  });

  it("shows the Persian message, not the code, when the server refuses", async () => {
    mergeStatus = 409;
    render(<DuplicatesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "نگه‌داشتن «سارا»" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ادغام نهایی" }));
    await waitFor(() => expect(screen.getByText(MERGE_BLOCKED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText("party_merge_blocked")).toBeNull();
    expect(posts).toEqual([{ winnerId: "p1", loserId: "p2" }]);
  });
});
