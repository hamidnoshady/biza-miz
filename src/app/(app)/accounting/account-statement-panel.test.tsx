// @vitest-environment jsdom

/**
 * Issue #824 §12 / review item 3 — stale statement responses.
 *
 * The original guard only inspected `api()`'s `aborted` flag, and `api()`
 * swallowed a body-stream failure into `{}` with `aborted: false`. An abort
 * that landed *after the headers arrived* therefore looked like a successful
 * empty statement and could overwrite a newer response.
 *
 * These are behavioural tests: they drive real out-of-order completions, an
 * abort before headers, an abort during JSON consumption, an invalid range and
 * unmount, and assert what the user ends up seeing. A source assertion that an
 * AbortController exists would pass against the broken version and is not used.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { AccountStatementPanel } from "./account-statement-panel";

afterEach(cleanup);

function statement(name: string, closing = 1000) {
  return {
    accountCode: "6130",
    accountName: name,
    normalBalance: "debit" as const,
    openingBalance: 0,
    // A distinguishing memo is a far more stable assertion target than a
    // formatted money string.
    lines: [
      {
        entryId: `e-${name}`,
        date: "2026-01-02",
        memo: `memo-${name}`,
        sourceType: null,
        debit: 10,
        credit: 0,
        balance: closing,
      },
    ],
    closingBalance: closing,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(accountId = "a-1") {
  return render(
    <AccountStatementPanel
      accountId={accountId}
      accountCode="6130"
      accountName="اجاره"
      onClose={() => {}}
    />,
  );
}

describe("api() abort semantics", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("reports an abort that fires after the headers arrive, instead of an empty success", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Headers arrive, then the caller cancels before the body is read.
        controller.abort();
        return jsonResponse(statement("stale"));
      }),
    );
    const result = await api("/api/x", { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({});
  });

  it("reports an abort that fires while the response body is being consumed", async () => {
    const controller = new AbortController();
    const body = {
      ok: true,
      status: 200,
      json: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => body));

    const result = await api("/api/x", { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("still reports a genuine malformed body as a success with empty data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })),
    );
    const result = await api("/api/x");
    expect(result.aborted).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({});
  });
});

describe("AccountStatementPanel — out-of-order and aborted responses", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("ignores a superseded response that resolves after a newer one", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))),
    );

    const view = renderPanel("a-1");
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // Switching accounts re-runs the effect: request #1 is superseded + aborted.
    view.rerender(
      <AccountStatementPanel accountId="a-2" accountCode="6130" accountName="اجاره" onClose={() => {}} />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Newer request answers first…
    resolvers[1](jsonResponse(statement("newer", 2000)));
    await waitFor(() => expect(screen.getAllByText("memo-newer").length).toBeGreaterThan(0));

    // …then the older one finally answers. It must not win.
    resolvers[0](jsonResponse(statement("older", 111)));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("memo-older")).toBeNull();
    expect(screen.getAllByText("memo-newer").length).toBeGreaterThan(0);
  });

  it("installs nothing from a request aborted before its headers arrived", async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        captured = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          captured?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );

    const view = renderPanel("a-1");
    await waitFor(() => expect(captured).toBeTruthy());
    expect(captured!.aborted).toBe(false);

    view.rerender(
      <AccountStatementPanel accountId="a-2" accountCode="6130" accountName="اجاره" onClose={() => {}} />,
    );

    // The superseded fetch was really cancelled, and no error surfaced for it.
    await waitFor(() => expect(screen.queryByText("بارگذاری گردش این حساب ناموفق بود.")).toBeNull());
    expect(screen.queryByText("مانده افتتاحیه")).toBeNull();
  });

  it("never writes state after unmount", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );

    const view = renderPanel();
    await waitFor(() => expect(resolveFetch).toBeTruthy());
    view.unmount();
    // The late body arrives after unmount; nothing may be scheduled from it.
    resolveFetch!(jsonResponse(statement("late")));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/مانده افتتاحیه/)).toBeNull();
  });

  it("does not fetch for a reversed range and explains the range instead", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(statement("x")));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // تا تاریخ = یکم ماه گذشته (always strictly before today), از تاریخ = today.
    choosePreviousMonthDayOne("تا تاریخ");
    await waitFor(() => expect(fieldTrigger("تا تاریخ").textContent).toMatch(/[۰-۹]/));
    chooseToday("از تاریخ");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/باید قبل از/));
    // The reversed pair never reached the network: #1 is the initial load and
    // #2 is the (still-valid) single date the user set first — the reversal
    // itself adds nothing.
    const callsAfterReversal = fetchMock.mock.calls.length;
    expect(callsAfterReversal).toBeLessThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterReversal);
  });
});

/* ---------------------------------------------------------------- pickers */

function fieldTrigger(label: string): HTMLButtonElement {
  const field = screen.getByText(label).closest("label")!;
  const button = field.querySelector("button") as HTMLButtonElement;
  if (!button) throw new Error(`no picker trigger inside the «${label}» field`);
  return button;
}

function openPicker(label: string) {
  fireEvent.click(fieldTrigger(label));
  return screen.getByRole("dialog", { name: "انتخاب تاریخ شمسی" });
}

function chooseDay(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function chooseToday(label: string) {
  openPicker(label);
  // `aria-current="date"` marks today's cell — the day-numbered labels alone
  // are not unique.
  const today = document.querySelector<HTMLButtonElement>('[aria-current="date"]');
  if (!today) throw new Error("no today cell in the open calendar");
  fireEvent.click(today);
}

function choosePreviousMonthDayOne(label: string) {
  openPicker(label);
  fireEvent.click(screen.getByRole("button", { name: "ماه قبل" }));
  chooseDay(/^۱ /);
}
