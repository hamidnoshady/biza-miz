// @vitest-environment jsdom
/**
 * Issue #821 — «برگشت سند» must be confirmed, and what the reader confirms
 * must be what gets posted.
 *
 * Reversing used to be one click with no summary, no reason and no control
 * over the reversing document's date. The rules around it are pure and tested
 * elsewhere; what this file pins is the dialog's own behaviour, which is not:
 * that it shows the original and the swapped lines before anything is posted,
 * that the memo and the Jalali date actually reach the API, that a double
 * click cannot race two reversals of one document, and that the API's refusal
 * is explained here rather than in a page-level box the reader has scrolled
 * away from.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { JournalReversalDialog } from "./journal-reversal-dialog";
import type { JournalEntryView } from "./journal-view";

const ENTRY: JournalEntryView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entryDate: "2026-02-14",
  postedAt: "2026-02-14T09:30:00.000Z",
  memo: "اجارهٔ بهمن",
  sourceType: "manual",
  sourceId: null,
  locationId: null,
  locationName: "شعبهٔ مرکزی",
  projectId: null,
  projectName: null,
  createdBy: null,
  createdByName: "حسابدار",
  reversesEntryId: null,
  reversedByEntryId: null,
  reversedAt: null,
  reversedBy: null,
  reversedByName: null,
  totalDebit: "9007199254740993",
  lines: [
    {
      entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      accountCode: "5100",
      accountName: "هزینهٔ اجاره",
      debit: "9007199254740993",
      credit: "0",
    },
    {
      entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      accountCode: "1100",
      accountName: "صندوق",
      debit: "0",
      credit: "9007199254740993",
    },
  ],
};

/** Resolves the POST only when the test says so, so an in-flight submit can be observed. */
function deferredFetch() {
  let release: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pending);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, release };
}

function serve(body: unknown, status = 201) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(onReversed = vi.fn()) {
  render(
    <MoneyProvider unit="rial">
      <JournalReversalDialog entry={ENTRY} onClose={vi.fn()} onReversed={onReversed} />
    </MoneyProvider>,
  );
  return onReversed;
}

function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: "تأیید و ثبت سند برگشتی" });
}

function bodyOf(fetchMock: {
  mock: { calls: [RequestInfo | URL, (RequestInit | undefined)?][] };
}): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("JournalReversalDialog — what the reader is shown before anything is posted", () => {
  it("summarises the original and says plainly that this is not an undo", () => {
    const fetchMock = serve({ entryId: "rev-1" });
    renderDialog();

    expect(screen.getByText("اجارهٔ بهمن")).toBeTruthy();
    expect(screen.getByText("شعبهٔ مرکزی")).toBeTruthy();
    expect(screen.getByText("حسابدار")).toBeTruthy();
    expect(screen.getByText(/سند اصلی در دفتر باقی می‌ماند/)).toBeTruthy();
    // Opening the dialog posts nothing; the API is only touched on confirm.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews the lines with debit and credit swapped, at exact BIGINT precision", () => {
    serve({ entryId: "rev-1" });
    renderDialog();
    // The dialog renders through a portal, so the document — not the render
    // container — is where it lives.
    const rows = document.querySelectorAll("tbody tr");
    // The expense line was a debit; in the reversing document it is a credit.
    const expenseCells = rows[0].querySelectorAll("td");
    expect(expenseCells[1].textContent).toBe("—");
    expect(expenseCells[2].textContent).toContain("۹۹۳");
    expect(expenseCells[2].textContent).not.toContain("۹۹۴");
  });
});

describe("JournalReversalDialog — what reaches the API", () => {
  it("posts to the entry's reverse route with the typed reason", async () => {
    const fetchMock = serve({ entryId: "rev-1" });
    const onReversed = renderDialog();

    fireEvent.change(screen.getByPlaceholderText(/برگشت سند:/), { target: { value: "اشتباه در مبلغ" } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onReversed).toHaveBeenCalledWith("rev-1"));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/ledger/entries/${ENTRY.id}/reverse`);
    expect(bodyOf(fetchMock).memo).toBe("اشتباه در مبلغ");
  });

  it("omits an untouched reason and date, so the API applies its own defaults", async () => {
    const fetchMock = serve({ entryId: "rev-1" });
    renderDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock);
    expect(body.memo).toBeUndefined();
    expect(body.entryDate).toBeUndefined();
  });

  it("sends a date chosen on the Shamsi calendar as an ISO date", async () => {
    const fetchMock = serve({ entryId: "rev-1" });
    renderDialog();

    // The picker shows a Jalali calendar and reports Gregorian ISO — the
    // repo's rule that a user never meets a Gregorian date, and storage never
    // meets a Jalali one.
    fireEvent.click(screen.getByRole("button", { name: "تاریخ سند برگشتی" }));
    const fifteenth = (await screen.findAllByRole("button", { name: /^۱۵ / }))[0];
    fireEvent.click(fifteenth);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock).entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("JournalReversalDialog — one document, one reversal", () => {
  it("ignores a second click while the first is still in flight", async () => {
    const { fetchMock, release } = deferredFetch();
    renderDialog();

    // Captured once: after the first click the control relabels itself «در حال
    // ثبت…», which is the visible half of the same guard.
    const confirm = confirmButton();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(confirm.textContent).toContain("در حال ثبت");

    release(new Response(JSON.stringify({ entryId: "rev-1" }), { status: 201 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("explains the API's refusal in the dialog the reader is looking at", async () => {
    serve({ error: "already_reversed" }, 409);
    const onReversed = renderDialog();

    fireEvent.click(confirmButton());

    expect(await screen.findByText(/هم‌اکنون توسط فرد دیگری برگشت خورده است/)).toBeTruthy();
    expect(onReversed).not.toHaveBeenCalled();
  });

  it("explains a locked fiscal period rather than failing silently", async () => {
    serve({ error: "fiscal_period_locked" }, 409);
    renderDialog();
    fireEvent.click(confirmButton());
    expect(await screen.findByText(/دورهٔ مالیِ تاریخ انتخاب‌شده قفل است/)).toBeTruthy();
  });
});
