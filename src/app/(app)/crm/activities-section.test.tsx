// @vitest-environment jsdom

/**
 * The task list's filter wiring — the half a pure unit test cannot see.
 *
 * `crm-activity-views.test.ts` pins the vocabulary and the SQL is pinned in
 * `integration/crm-activities.integration.test.ts`; this file pins the joins,
 * because those are where a filter quietly stops being applied:
 *
 *  1. **The request is the filter document.** Every control must show up in the
 *     next request's query string. This is the screen whose search box used to
 *     filter *the rows already loaded*, so a term that never reaches the wire is
 *     exactly the bug this wave removes.
 *  2. **A refused filter names the field and keeps the rows.** An impossible
 *     value is not «کاری نیست».
 *  3. **The chips are the applied document**, so a list cannot be labelled with
 *     a filter the server was never asked for.
 *  4. **The saved view round-trips through the same document.**
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/crm/activities",
  useSearchParams: () => new URLSearchParams(),
}));

import { ActivitiesSection } from "./activities-section";

afterEach(cleanup);

const MEMBER = "33333333-3333-4333-8333-333333333333";

function activity(over: Record<string, unknown> = {}) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    customerId: null,
    customerName: "مشتری الف",
    dealId: null,
    caseId: null,
    kind: "call",
    subject: "تماس پیگیری",
    body: "",
    dueAt: null,
    completedAt: null,
    assignedTo: "",
    assigneeUserId: null,
    createdBy: "مدیر",
    createdAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

const ACTIVITIES = [
  activity({ id: "task-call", subject: "تماس پیگیری" }),
  activity({ id: "task-visit", subject: "مراجعه حضوری", kind: "visit" }),
];

let savedWrites: { url: string; body: string }[] = [];

function stubApi(overrides: { activitiesReply?: () => unknown } = {}) {
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
    const body = overrides.activitiesReply?.() ?? {
      activities: ACTIVITIES,
      today: "2026-08-20",
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

/** The activities read, which is the only request that carries the filters. */
function lastActivitiesRequest(requests: string[]): string {
  return [...requests].reverse().find((url) => url.startsWith("/api/crm/activities")) ?? "";
}

describe("ActivitiesSection filters", () => {
  it("carries every control into the request the server reads", async () => {
    const requests = stubApi();
    render(<ActivitiesSection canSaveViews />);
    await screen.findByLabelText("جست‌وجو");

    // The list opens on the unfinished work, as it always has.
    await waitFor(() => expect(lastActivitiesRequest(requests)).toContain("state=open"));

    // The search reaches the wire — the whole point of the wave: it used to
    // filter the rows already loaded, so a task beyond the page never appeared.
    await userEvent.type(screen.getByLabelText("جست‌وجو"), "یخچال");
    await waitFor(() =>
      expect(lastActivitiesRequest(requests)).toContain("q=%DB%8C%D8%AE%DA%86%D8%A7%D9%84"),
    );

    await userEvent.selectOptions(screen.getByLabelText("نوع"), "visit");
    await waitFor(() => expect(lastActivitiesRequest(requests)).toContain("kind=visit"));

    await userEvent.selectOptions(screen.getByLabelText("وضعیت"), "overdue");
    await waitFor(() => expect(lastActivitiesRequest(requests)).toContain("state=overdue"));

    await userEvent.selectOptions(screen.getByLabelText("مسئول"), "none");
    await waitFor(() => expect(lastActivitiesRequest(requests)).toContain("assignee=none"));

    const chips = screen.getByLabelText("فیلترهای اعمال‌شده");
    expect(within(chips).getByText("جست‌وجو: «یخچال»")).toBeTruthy();
    expect(within(chips).getByText("نوع: مراجعه حضوری")).toBeTruthy();
    expect(within(chips).getByText("وضعیت: عقب‌افتاده")).toBeTruthy();
    expect(within(chips).getByText("بدون مسئول")).toBeTruthy();

    // The document reaches a saved view too: a view is worth nothing if what it
    // stores is not what the reader saw when they named it.
    await userEvent.click(screen.getByRole("button", { name: /ذخیرهٔ نما/ }));
    await userEvent.type(await screen.findByLabelText(/نام نما/), "تماس‌های عقب‌افتاده");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(savedWrites).toHaveLength(1));
    expect(JSON.parse(savedWrites[0].body).filters).toEqual({
      q: "یخچال",
      kind: "visit",
      state: "overdue",
      assignee: "none",
    });

    // One click puts the reader's own filters back, and the list's own default
    // (unfinished) stays, because that is the screen's, not a chosen filter.
    await userEvent.click(screen.getByRole("button", { name: "برداشتن فیلترها" }));
    await waitFor(() => expect(lastActivitiesRequest(requests)).not.toContain("assignee="));
    expect(lastActivitiesRequest(requests)).toContain("state=open");
    expect((screen.getByLabelText("جست‌وجو") as HTMLInputElement).value).toBe("");
  });

  it("names a refused filter and keeps the rows on screen", async () => {
    let refuse = false;
    stubApi({
      activitiesReply: () =>
        refuse
          ? { error: "bad_filter", field: "kind" }
          : { activities: ACTIVITIES, today: "2026-08-20", members: [] },
    });
    render(<ActivitiesSection canSaveViews />);
    await screen.findByText("تماس پیگیری");

    refuse = true;
    // The control can only produce a valid value, so the refusal arrives the way
    // a shared view with a stale value would: from the server.
    await userEvent.selectOptions(screen.getByLabelText("نوع"), "visit");

    expect(await screen.findByText("نوع انتخاب‌شده معتبر نیست.")).toBeTruthy();
    expect(screen.getByText("تماس پیگیری")).toBeTruthy();
  });

  it("applies a saved view through the filter document", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
      }
      requests.push(String(url));
      if (String(url).startsWith("/api/crm/saved-views")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            views: [
              {
                id: "view-calls",
                entity: "activities",
                name: "تماس‌های عقب‌افتادهٔ من",
                filters: { kind: "call", state: "overdue", assignee: "mine" },
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
        json: async () => ({ activities: ACTIVITIES, today: "2026-08-20", members: [] }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ActivitiesSection canSaveViews />);

    // The chip's accessible name carries its scope suffix («همگانی»), and the
    // delete control beside it is labelled with the view's name too — so the
    // chip is the first match, which is the one a person presses.
    const chip = (await screen.findAllByRole("button", { name: /تماس‌های عقب‌افتادهٔ من/ }))[0];
    await userEvent.click(chip);

    await waitFor(() => expect(lastActivitiesRequest(requests)).toContain("kind=call"));
    expect(lastActivitiesRequest(requests)).toContain("state=overdue");
    expect(lastActivitiesRequest(requests)).toContain("assignee=mine");
    // The view replaced the screen's default rather than merging with it.
    expect(lastActivitiesRequest(requests)).not.toContain("state=open&");
    const chips = screen.getByLabelText("فیلترهای اعمال‌شده");
    expect(within(chips).getByText("کارهای من")).toBeTruthy();
  });
});
