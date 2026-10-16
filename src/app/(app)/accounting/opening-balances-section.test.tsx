// @vitest-environment jsdom

/**
 * «ترازات افتتاحیه»'s dimension attribution contract (issue #868): the
 * carry-forward generator writes per-line attribution; this screen must SHOW
 * it (review, print) and must never STRIP it — the editor used to rebuild each
 * line without `dimensions`, so saving an edited carry-forward set silently
 * un-attributed every line.
 *
 * The service rules (mirrors at post, idempotent generation) are proven in
 * `opening-balances-service.test.ts` and the integration suite. What is proven
 * here is what the browser does with the attribution.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpeningBalancesSection } from "./opening-balances-section";
import type { AccountRow, Runner } from "./accounting-manager";

afterEach(cleanup);

const CASH = "11111111-1111-4111-8111-111111111111";
const RE = "22222222-2222-4222-8222-222222222222";
const SET_ID = "44444444-4444-4444-8444-444444444444";
const CC = "55555555-5555-4555-8555-555555555555";
const DEPT = "66666666-6666-4666-8666-666666666666";
const DETAIL = "99999999-9999-4999-8999-999999999999";

const ACCOUNTS: AccountRow[] = [
  { id: RE, code: "3100", name: "سرمایه", type: "equity", parent_code: null, is_postable: true, has_children: false },
  { id: CASH, code: "1001", name: "صندوق", type: "asset", parent_code: null, is_postable: true, has_children: false },
];

function theSet(overrides: Record<string, unknown> = {}) {
  return {
    id: SET_ID,
    fiscalYearLabel: "1405",
    fiscalYearId: null,
    effectiveDate: "2026-03-21",
    status: "draft",
    source: "carry_forward",
    carryForwardFromYearId: "77777777-7777-4777-8777-777777777777",
    journalEntryId: null,
    reversalEntryId: null,
    totalDebit: "50000000",
    totalCredit: "50000000",
    note: null,
    createdBy: "user-1",
    createdAt: "2026-03-21T08:00:00.000Z",
    submittedAt: null,
    approvedAt: null,
    postedAt: null,
    reversedAt: null,
    reversedReason: null,
    createdByName: "زهرا احمدی",
    ...overrides,
  };
}

function theLine(dimensions: Record<string, string> | null = { cost_center: CC, department: DEPT, detail: DETAIL }) {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    accountId: RE,
    accountCode: "3100",
    accountName: "سرمایه",
    debit: "50000000",
    credit: "0",
    partyType: null,
    partyId: null,
    partyName: null,
    reference: null,
    sourceNote: null,
    dimensions,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path === "/api/ledger/opening-balances") {
      return { ok: true, status: 200, json: async () => ({ sets: [theSet()] }) };
    }
    if (path === "/api/ledger/fiscal-years") {
      return { ok: true, status: 200, json: async () => ({ fiscalYears: [] }) };
    }
    if (path === `/api/ledger/opening-balances/${SET_ID}`) {
      return { ok: true, status: 200, json: async () => ({ set: theSet(), lines: [theLine()] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

function renderSection() {
  const run: Runner = async (fn) => {
    const { ok } = await fn();
    return ok;
  };
  return render(
    <OpeningBalancesSection accounts={ACCOUNTS} busy={false} run={run} refreshKey={0} canApprove />,
  );
}

function putCall(): { lines: { dimensions?: Record<string, string | null> }[] } | null {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === `/api/ledger/opening-balances/${SET_ID}` && (init as RequestInit | undefined)?.method === "PUT",
  );
  if (!call) return null;
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as { lines: { dimensions?: Record<string, string | null> }[] };
}

/** The catalog the mocked hook reports: cost centre on; an archived department value. */
vi.mock("./dimension-fields", () => ({
  useDimensionCatalog: () => ({
    catalog: {
      settings: [
        { kind: "cost_center", isEnabled: true, label: null, defaultLabel: "مرکز هزینه", description: "" },
        { kind: "profit_center", isEnabled: false, label: null, defaultLabel: "مرکز سود", description: "" },
        { kind: "department", isEnabled: true, label: null, defaultLabel: "واحد سازمانی", description: "" },
        { kind: "detail", isEnabled: false, label: null, defaultLabel: "بعد تحلیلی", description: "" },
      ],
      postableValues: [],
      allValues: [
        { id: CC, kind: "cost_center", code: "CC-1", name: "دفتر مرکزی", isActive: true, hasChildren: false },
        { id: DEPT, kind: "department", code: "D-1", name: "مالی", isActive: false, hasChildren: false },
        { id: DETAIL, kind: "detail", code: "X-1", name: "پروژه‌ها", isActive: false, hasChildren: false },
      ],
      truncated: false,
      truncatedAt: null,
    },
    loaded: true,
    error: null,
    retry: () => undefined,
  }),
  DimensionFields: ({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) => (
    <button type="button" onClick={() => onChange({ ...value, cost_center: CC })}>
      انتخاب مرکز هزینه
    </button>
  ),
}));

describe("OpeningBalancesSection — dimension attribution (issue #868)", () => {
  it("shows each line's attribution beside its account, archived values included", async () => {
    renderSection();
    // The set's detail loads asynchronously once the list selects it. The
    // attribution sub-line renders in both the desktop table and the mobile
    // card — the same contract, two layouts.
    const shown = await screen.findAllByText("مرکز هزینه: CC-۱ · دفتر مرکزی");
    expect(shown.length).toBeGreaterThanOrEqual(2);
    // An archived value stays readable, labelled — history is never blank.
    expect(screen.getAllByText("واحد سازمانی: D-۱ · مالی (بایگانی)").length).toBeGreaterThanOrEqual(2);
    // The split is annotated on the line; the account appears in exactly one
    // table row (the split is not rows of its own, so totals cannot double).
    const rows = screen.getAllByRole("row");
    const attributedRows = rows.filter((r) => r.textContent?.includes("سرمایه"));
    expect(attributedRows.length).toBe(1);
  });

  it("keeps attribution through an edit — saving never strips the line's ids", async () => {
    renderSection();
    await screen.findAllByText("مرکز هزینه: CC-۱ · دفتر مرکزی");
    fireEvent.click(screen.getByRole("button", { name: "ویرایش خطوط" }));
    // Change nothing that matters to attribution; just save the editor back.
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ خطوط" }));
    await waitFor(() => expect(putCall()).not.toBeNull());
    const body = putCall();
    expect(body?.lines[0]?.dimensions).toEqual({ cost_center: CC, department: DEPT, detail: DETAIL });
  });

  it("sends a picker change as the line's new attribution", async () => {
    renderSection();
    await screen.findAllByText("مرکز هزینه: CC-۱ · دفتر مرکزی");
    fireEvent.click(screen.getByRole("button", { name: "ویرایش خطوط" }));
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ خطوط" }));
    await waitFor(() => expect(putCall()).not.toBeNull());
    const body = putCall();
    expect(body?.lines[0]?.dimensions?.cost_center).toBe(CC);
    // The picker-managed kind changed; the unmanaged ones still round-trip.
    expect(body?.lines[0]?.dimensions?.department).toBe(DEPT);
  });

  it("says which attribution it is keeping that the form cannot edit, and keeps it", async () => {
    renderSection();
    await screen.findAllByText("مرکز هزینه: CC-۱ · دفتر مرکزی");
    fireEvent.click(screen.getByRole("button", { name: "ویرایش خطوط" }));
    // The detail kind is switched off, so it has no picker — the editor names
    // what it is preserving and the save carries it unchanged.
    expect(screen.getByText(/انتساب نگه‌داشته‌شده/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ خطوط" }));
    await waitFor(() => expect(putCall()).not.toBeNull());
    expect(putCall()?.lines[0]?.dimensions?.detail).toBe(DETAIL);
  });
});
