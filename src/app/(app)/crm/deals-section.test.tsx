// @vitest-environment jsdom

/**
 * The deals screen's filter wiring — the half a pure unit test cannot see.
 *
 * `crm-deal-views.test.ts` pins the vocabulary and the SQL is pinned in
 * `integration/crm-relationship-os.integration.test.ts`; this file pins the
 * joins between them, because those are where a filter quietly stops being
 * applied:
 *
 *  1. **The request is the filter document.** Changing a control must show up in
 *     the next request's query string — a control that renders and does not
 *     travel is exactly the bug this wave exists to remove.
 *  2. **A refused filter keeps the list and names the field.** The server answers
 *     `bad_filter` with the field; blanking the board would read as "nothing
 *     matches" when the truth is "that value is not valid".
 *  3. **The chips are the applied document.** Every filter in force is described
 *     above the board, so a shared view cannot show a list it is not filtered
 *     by.
 *  4. **The list is the same rows, sorted by value.** The board answers "what do
 *     I move next"; the list answers "what is worth the most", and both open the
 *     same dialog.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";

// The section reads `?deal=<id>` to open one deal handed over by another
// screen. There is no router in a test, so the hook answers an empty query —
// which is also the state a fresh visit starts in.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/crm/deals",
  useSearchParams: () => new URLSearchParams(),
}));

import { DealsSection } from "./deals-section";

afterEach(cleanup);

const STAGE_OPEN = "11111111-1111-4111-8111-111111111111";
const STAGE_WON = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

const PIPELINE = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "قیف فروش",
  isDefault: true,
  stages: [
    {
      id: STAGE_OPEN,
      name: "مذاکره",
      displayOrder: 1,
      defaultProbability: 50,
      outcome: "open",
      isActive: true,
      requirementNote: "",
      legacyKey: "negotiation",
    },
    {
      id: STAGE_WON,
      name: "برنده",
      displayOrder: 2,
      defaultProbability: 100,
      outcome: "won",
      isActive: true,
      requirementNote: "",
      legacyKey: "won",
    },
  ],
};

function deal(over: Record<string, unknown>) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    customerId: null,
    customerName: "مشتری الف",
    title: "معامله الف",
    description: "",
    stage: "negotiation",
    stageId: STAGE_OPEN,
    pipelineId: PIPELINE.id,
    valueRial: 10_000_000,
    probability: 50,
    expectedCloseDate: null,
    ownerUser: "زهرا کریمی",
    ownerUserId: MEMBER,
    source: "",
    lostReason: null,
    orderId: null,
    closedAt: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

const DEALS = [
  deal({ id: "deal-small", title: "معامله کوچک", valueRial: 1_000_000 }),
  deal({ id: "deal-big", title: "معامله بزرگ", valueRial: 900_000_000 }),
];

/** Answers the deals read and the saved-view read, recording every request. */
function stubApi(overrides: { dealsReply?: () => unknown } = {}) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    requests.push(String(url));
    if (String(url).startsWith("/api/crm/saved-views")) {
      return { ok: true, status: 200, json: async () => ({ views: [] }) } as unknown as Response;
    }
    const body = overrides.dealsReply?.() ?? {
      deals: DEALS,
      pipeline: PIPELINE,
      pipelines: [{ id: PIPELINE.id, name: PIPELINE.name, isDefault: true }],
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
  return render(
    <MoneyProvider unit="toman">
      <DealsSection canManage />
    </MoneyProvider>,
  );
}

describe("DealsSection filters", () => {
  it("carries every control into the request the server reads", async () => {
    const requests = stubApi();
    renderSection();
    await screen.findByLabelText("جست‌وجو");

    await userEvent.type(screen.getByLabelText("جست‌وجو"), "بزرگ");
    await waitFor(() =>
      expect(requests.some((url) => url.includes("q=%D8%A8%D8%B2%D8%B1%DA%AF"))).toBe(true),
    );

    await userEvent.selectOptions(screen.getByLabelText("مرحله"), STAGE_OPEN);
    await waitFor(() => expect(requests.at(-1)).toContain(`stageId=${STAGE_OPEN}`));

    await userEvent.selectOptions(screen.getByLabelText("مسئول"), "none");
    await waitFor(() => expect(requests.at(-1)).toContain("owner=none"));

    await userEvent.click(screen.getByLabelText(/فقط معامله‌های باز/));
    await waitFor(() => expect(requests.at(-1)).toContain("open=1"));

    await userEvent.type(screen.getByLabelText(/از \(تومان\)/), "1000000");
    await waitFor(() => expect(requests.at(-1)).toContain("minValue=1000000"));

    // The filter document survives the round trip: the chips above the board
    // describe exactly what the last request asked for.
    const chips = screen.getByLabelText("فیلترهای اعمال‌شده");
    expect(within(chips).getByText("جست‌وجو: «بزرگ»")).toBeTruthy();
    expect(within(chips).getByText("مرحله: مذاکره")).toBeTruthy();
    expect(within(chips).getByText("بدون مسئول")).toBeTruthy();
    expect(within(chips).getByText("فقط بازها")).toBeTruthy();
    expect(within(chips).getByText(/از ۱٬۰۰۰٬۰۰۰ تومان/)).toBeTruthy();

    // And one click puts it all back.
    await userEvent.click(screen.getByRole("button", { name: "برداشتن فیلترها" }));
    await waitFor(() => expect(requests.at(-1)).not.toContain("minValue"));
    expect((screen.getByLabelText("جست‌وجو") as HTMLInputElement).value).toBe("");
  });

  it("names a refused filter and keeps the rows on screen", async () => {
    let refuse = false;
    stubApi({
      dealsReply: () =>
        refuse
          ? { error: "bad_filter", field: "stageId" }
          : {
              deals: DEALS,
              pipeline: PIPELINE,
              pipelines: [{ id: PIPELINE.id, name: PIPELINE.name, isDefault: true }],
              members: [],
            },
    });
    renderSection();
    await screen.findByText("معامله بزرگ");

    refuse = true;
    // The control can only produce a valid value, so the refusal arrives the way
    // a shared view with a stale stage would: from the server.
    await userEvent.selectOptions(screen.getByLabelText("مرحله"), STAGE_WON);

    expect(await screen.findByText("مرحلهٔ انتخاب‌شده معتبر نیست.")).toBeTruthy();
    // The last good rows are still here: an impossible filter is not "no deals".
    expect(screen.getByText("معامله بزرگ")).toBeTruthy();
  });

  it("offers the same rows as a list, sorted by value", async () => {
    stubApi();
    renderSection();
    await screen.findByText("معامله بزرگ");

    await userEvent.click(screen.getByRole("button", { name: "فهرست" }));

    const items = screen.getAllByRole("listitem").filter((item) => item.textContent?.includes("معامله"));
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("معامله بزرگ"),
      expect.stringContaining("معامله کوچک"),
    ]);
    // Ownership is legible: the member's id decides which half of the label is
    // used, and both halves are shown when the row is a paid-for one.
    expect(screen.getAllByText("زهرا کریمی").length).toBeGreaterThan(0);
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
                id: "view-big",
                entity: "deals",
                name: "معامله‌های بزرگ",
                filters: { owner: "mine", minValue: "5000000" },
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
        json: async () => ({
          deals: DEALS,
          pipeline: PIPELINE,
          pipelines: [{ id: PIPELINE.id, name: PIPELINE.name, isDefault: true }],
          members: [{ id: MEMBER, name: "زهرا کریمی", isActive: true }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    // The chip's accessible name carries its scope suffix («همگانی»), and the
    // delete control beside it is labelled with the view's name too — so the
    // chip is the first match, which is the one a person presses.
    const chip = (await screen.findAllByRole("button", { name: /معامله‌های بزرگ/ }))[0];
    await userEvent.click(chip);
    await waitFor(() => expect(requests.at(-1)).toContain("owner=mine"));
    expect(requests.at(-1)).toContain("minValue=5000000");
    // The control shows the stored Toman in Persian digits: the view's document
    // and the field a person would have typed are the same number.
    expect((screen.getByLabelText(/از \(تومان\)/) as HTMLInputElement).value).toContain("۵٬۰۰۰٬۰۰۰");
  });
});
