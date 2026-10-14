// @vitest-environment jsdom

/**
 * The service desk's filter wiring — the half a pure unit test cannot see.
 *
 * `crm-case-views.test.ts` pins the vocabulary, `crm-case-clock.test.ts` pins
 * the rule, and `integration/crm-case-views.test.ts` pins the SQL against the
 * rule; this file pins the joins between them, because those are where a filter
 * quietly stops being applied:
 *
 *  1. **The request is the filter document.** Every control must show up in the
 *     next request's query string — the desk declared six filter keys to
 *     `crm_saved_views` and honoured two, which is exactly how a shared view
 *     named «فوری‌های معوق» opened showing everything.
 *  2. **A refused filter names the field and keeps the rows.** An impossible
 *     value is not «تیکتی نیست».
 *  3. **The chips are the applied document**, so a list cannot be labelled with
 *     a filter the server was never asked for.
 *  4. **The SLA panel is the same clock as the rows** — the panel says «از مهلت
 *     گذشته: ۲» and the rows it sits above must be lateness-marked by the same
 *     rule, or the two are two opinions.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The section reads `?case=<id>` to open one ticket handed over by the customer
// timeline. There is no router in a test, so the hook answers an empty query —
// which is also the state a fresh visit starts in.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/crm/cases",
  useSearchParams: () => new URLSearchParams(),
}));

import { CasesSection } from "./cases-section";

afterEach(cleanup);

const MEMBER = "33333333-3333-4333-8333-333333333333";

/** A ticket opened long enough ago to be late whatever the clock says. */
function serviceCase(over: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    customerId: null,
    customerName: "مشتری الف",
    subject: "یخچال خراب",
    body: "دو هفته است منتظر تعمیر هستم.",
    status: "open",
    priority: "urgent",
    category: "",
    orderId: null,
    assignedTo: "",
    assigneeUserId: null,
    resolution: "",
    openedAt: "2020-01-01T00:00:00.000Z",
    resolvedAt: null,
    ...over,
  };
}

const CASES = [
  serviceCase({ id: "case-old", subject: "یخچال خراب" }),
  serviceCase({ id: "case-new", subject: "لباسشویی صدا می‌دهد" }),
];

const SLA = {
  open: 2,
  breached: 1,
  waitingOnCustomer: 1,
  atRisk: 0,
  medianFirstResponseSeconds: 5400,
};

/** The desk's own read, which is the only one that carries the filters. */
function lastCasesRequest(requests: string[]): string {
  return [...requests].reverse().find((url) => url.startsWith("/api/crm/cases")) ?? "";
}

/**
 * The last saved-view write, as its body.
 *
 * `stubApi` keeps the writes so a test can ask what a saved view would actually
 * store — the answer a shared view's readers will live with.
 */
let savedWrites: { url: string; body: string }[] = [];

function savedBody(): { url: string; body: string } | null {
  return savedWrites.at(-1) ?? null;
}

/** Answers the desk read and the saved-view read, recording every request. */
function stubApi(overrides: { casesReply?: () => unknown } = {}) {
  const requests: string[] = [];
  savedWrites = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).startsWith("/api/crm/saved-views")) {
      savedWrites.push({ url: String(url), body: String(init.body ?? "") });
      return { ok: true, status: 201, json: async () => ({ view: {} }) } as unknown as Response;
    }
    requests.push(String(url));
    if (String(url).startsWith("/api/crm/saved-views")) {
      return { ok: true, status: 200, json: async () => ({ views: [] }) } as unknown as Response;
    }
    const body = overrides.casesReply?.() ?? {
      cases: CASES,
      sla: SLA,
      members: [{ id: MEMBER, name: "زهرا کریمی", isActive: true }],
    };
    // A body carrying an error is a refusal, and the stub has to say so the way
    // the real `api()` sees it: `ok` comes from the HTTP status, not the body.
    const failed = typeof body === "object" && body !== null && "error" in body;
    return {
      ok: !failed,
      status: failed ? 400 : 200,
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

function renderSection() {
  return render(<CasesSection canDelete canSaveViews />);
}

describe("CasesSection filters", () => {
  it("carries every control into the request the server reads", async () => {
    const requests = stubApi();
    renderSection();
    await screen.findByLabelText("جست‌وجو");

    // The desk opens on the open tickets, as it always has.
    await waitFor(() => expect(lastCasesRequest(requests)).toContain("open=1"));

    await userEvent.type(screen.getByLabelText("جست‌وجو"), "یخچال");
    await waitFor(() =>
      expect(lastCasesRequest(requests)).toContain("q=%DB%8C%D8%AE%DA%86%D8%A7%D9%84"),
    );

    await userEvent.selectOptions(screen.getByLabelText("وضعیت"), "in_progress");
    await waitFor(() => expect(lastCasesRequest(requests)).toContain("status=in_progress"));

    await userEvent.selectOptions(screen.getByLabelText("اولویت"), "urgent");
    await waitFor(() => expect(lastCasesRequest(requests)).toContain("priority=urgent"));

    await userEvent.selectOptions(screen.getByLabelText("مسئول"), "none");
    await waitFor(() => expect(lastCasesRequest(requests)).toContain("assignee=none"));

    await userEvent.click(screen.getByLabelText(/فقط معوق‌ها/));
    await waitFor(() => expect(lastCasesRequest(requests)).toContain("breached=1"));

    // The filter document survives the round trip: the chips describe exactly
    // what the last request asked for.
    const chips = screen.getByLabelText("فیلترهای اعمال‌شده");
    expect(within(chips).getByText("جست‌وجو: «یخچال»")).toBeTruthy();
    expect(within(chips).getByText("وضعیت: در حال بررسی")).toBeTruthy();
    expect(within(chips).getByText("اولویت: فوری")).toBeTruthy();
    expect(within(chips).getByText("بدون مسئول")).toBeTruthy();
    expect(within(chips).getByText("فقط بازها")).toBeTruthy();
    expect(within(chips).getByText("فقط معوق‌ها")).toBeTruthy();

    // …and the same document reaches a saved view: «ذخیرهٔ نما» posts the
    // filters that are on the screen right now, not an empty set or the last
    // one loaded. A view is worth nothing if what it stores is not what the
    // reader saw when they named it.
    await userEvent.click(screen.getByRole("button", { name: /ذخیرهٔ نما/ }));
    await userEvent.type(await screen.findByLabelText(/نام نما/), "فوری‌های من");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(savedBody()).not.toBeNull());
    expect(JSON.parse(savedBody()!.body).filters).toEqual({
      q: "یخچال",
      status: "in_progress",
      priority: "urgent",
      assignee: "none",
      open: "1",
      breached: "1",
    });

    // One click puts the search, status, priority and assignee back — while the
    // desk's own open-only default stays, because that is the screen's, not a
    // filter the reader chose.
    await userEvent.click(screen.getByRole("button", { name: "برداشتن فیلترها" }));
    await waitFor(() => expect(lastCasesRequest(requests)).not.toContain("priority="));
    expect((screen.getByLabelText("جست‌وجو") as HTMLInputElement).value).toBe("");
    expect(lastCasesRequest(requests)).toContain("open=1");
  });

  it("names a refused filter and keeps the rows on screen", async () => {
    let refuse = false;
    stubApi({
      casesReply: () =>
        refuse
          ? { error: "bad_filter", field: "priority" }
          : { cases: CASES, sla: SLA, members: [] },
    });
    renderSection();
    await screen.findByText("یخچال خراب");

    refuse = true;
    // The control can only produce a valid value, so the refusal arrives the way
    // a shared view with a stale value would: from the server.
    await userEvent.selectOptions(screen.getByLabelText("وضعیت"), "waiting");

    expect(await screen.findByText("اولویت انتخاب‌شده معتبر نیست.")).toBeTruthy();
    // The last good rows are still here: an impossible filter is not «تیکتی نیست».
    expect(screen.getByText("یخچال خراب")).toBeTruthy();
  });

  it("renders the SLA position from the same clock as the rows", async () => {
    stubApi();
    renderSection();
    await screen.findByText("یخچال خراب");

    // The figures the backend already computed are on the screen, kept apart:
    // waiting-on-the-customer is not folded into «از مهلت گذشته».
    const panel = within(screen.getByRole("group", { name: "وضعیت زمان هدف" }));
    /** The value printed beside a figure's own label. */
    const figure = (label: string) => panel.getByText(label).parentElement?.textContent ?? "";
    expect(figure("از مهلت گذشته")).toContain("۱");
    expect(figure("منتظر مشتری")).toContain("۱");
    // 5400 seconds is 90 minutes, and it is shown as the hour and a half it is
    // rather than rounded up to «۲ ساعت»: the desk's own response time is the
    // last place to flatter a number.
    expect(figure("میانهٔ اولین پاسخ")).toContain("۱.۵ ساعت");

    // The rows are lateness-marked by the same rule the figures came from.
    expect(screen.getAllByText("از زمان هدف گذشته").length).toBeGreaterThan(0);
  });

  it("applies a saved view through the filter document", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      requests.push(String(url));
      if (String(url).startsWith("/api/crm/saved-views")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            views: [
              {
                id: "view-urgent",
                entity: "cases",
                name: "فوری‌های معوق",
                filters: { priority: "urgent", breached: "1" },
                ownerUserId: null,
                isBuiltin: false,
                displayOrder: 0,
                createdBy: "مدیر",
              },
            ],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cases: CASES, sla: SLA, members: [] }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    // The chip's accessible name carries its scope suffix («همگانی»), and the
    // delete control beside it is labelled with the view's name too — so the
    // chip is the first match, which is the one a person presses.
    const chip = (await screen.findAllByRole("button", { name: /فوری‌های معوق/ }))[0];
    await userEvent.click(chip);

    await waitFor(() => expect(lastCasesRequest(requests)).toContain("priority=urgent"));
    expect(lastCasesRequest(requests)).toContain("breached=1");
    // Both of the view's keys are visible as chips: the row list is narrowed by
    // filters a person can see and remove, not by a hidden stored one.
    const chips = screen.getByLabelText("فیلترهای اعمال‌شده");
    expect(within(chips).getByText("اولویت: فوری")).toBeTruthy();
    expect(within(chips).getByText("فقط معوق‌ها")).toBeTruthy();
    // The view replaced the desk default rather than merging with it.
    expect(lastCasesRequest(requests)).not.toContain("open=1");
  });
});
