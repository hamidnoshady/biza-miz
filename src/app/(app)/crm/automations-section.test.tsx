// @vitest-environment jsdom

/**
 * The CRM's automations screen — «وقتی → اگر → آنگاه».
 *
 * What is pinned here, in order of how much damage the alternative does:
 *
 *  1. **A rule is read as a sentence.** The screen exists to answer "did a
 *     machine do something to my customers", and a rule that can only be read
 *     as a form is a rule nobody can audit six months later.
 *  2. **The composition is closed and converted once.** The body the screen
 *     sends holds a trigger, conditions from the declared vocabulary and one
 *     action's own config — and an amount typed in Toman leaves as Rial, because
 *     a threshold stored in the wrong unit is a rule that either never fires or
 *     fires on everything. A refusal from the API stays on screen with its
 *     reason: a rejected rule must never look saved.
 *  3. **The growth action carries no recipient.** Choosing «اطلاع به رشد و
 *     بازاریابی» swaps the member picker for a signal, and the request it sends
 *     has `memberId: null` — there is no channel, no template and no audience in
 *     this form, which is the product boundary said out loud.
 *  4. **A run that did nothing says why.** The feed distinguishes a skip
 *     («شرط‌ها برقرار نبود»), a failure (with the engine's own message) and a
 *     Growth signal, because "my rule never fires" is the question this screen
 *     gets asked.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrmAutomationRun } from "@/lib/crm-automation-service";
import { AutomationsSection } from "./automations-section";

afterEach(cleanup);

const RULE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "پیگیری مذاکره‌های بزرگ",
  triggerKey: "deal_stage_changed",
  conditions: [{ key: "value_at_least", value: "100000000" }],
  actionKey: "create_follow_up",
  actionConfig: { memberId: "member-active", offsetDays: 3, signal: null },
  actionMemberName: "زهرا کریمی",
  isActive: true,
  createdBy: "مدیر",
  runCount: 2,
  lastRunAt: "2026-09-01T09:30:00.000Z",
  createdAt: "2026-08-01T09:30:00.000Z",
  updatedAt: "2026-08-01T09:30:00.000Z",
};

const MEMBERS = [{ id: "member-active", name: "زهرا کریمی", role: "manager", isActive: true }];

interface Reply {
  status: number;
  body: unknown;
}

/**
 * A tiny fetch router: `api()` talks to real URLs, so the stub has to answer
 * per path — and the *calls* are what the composition tests assert on.
 */
function stubApi(handlers: Record<string, (init?: RequestInit) => Reply>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const path = String(url).split("?")[0];
    const reply = handlers[path]?.(init) ?? { status: 404, body: { error: "not_found" } };
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function payload(runs: CrmAutomationRun[] = []) {
  return { automations: [RULE], runs, counts: { active: 1, total: 1, appliedLast30: 2 } };
}

function run(over: Partial<CrmAutomationRun>): CrmAutomationRun {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    automationId: RULE.id,
    automationName: RULE.name,
    triggerKey: "deal_stage_changed",
    entityType: "deal",
    entityId: "33333333-3333-4333-8333-333333333333",
    outcome: "skipped",
    detail: {},
    at: "2026-09-02T09:30:00.000Z",
    ...over,
  } as CrmAutomationRun;
}

function postBody(calls: { url: string; init?: RequestInit }[]) {
  const call = calls.find((entry) => entry.init?.method === "POST");
  expect(call).toBeTruthy();
  return JSON.parse(String(call!.init!.body)) as Record<string, unknown>;
}

/** The member picker inside the builder, found by the member it offers. */
async function memberSelect(): Promise<HTMLSelectElement> {
  return await waitFor(() => {
    const found = screen
      .getAllByRole("combobox")
      .find((element) =>
        Array.from((element as HTMLSelectElement).options).some(
          (option) => option.textContent === "زهرا کریمی",
        ),
      );
    if (!found) throw new Error("member select is not ready");
    return found as HTMLSelectElement;
  });
}

describe("AutomationsSection", () => {
  it("reads a rule out as a sentence, not as a form", async () => {
    stubApi({
      "/api/crm/automations": () => ({ status: 200, body: payload() }),
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);

    const sentence = await screen.findByText(/وقتی جابه‌جایی فرصت در قیف/);
    // The condition's amount is the business's own unit, formatted — the row
    // stores Rial and the sentence says Toman like every other amount.
    expect(sentence.textContent).toContain("ارزش معامله دست‌کم");
    expect(sentence.textContent).toContain("۱۰٬۰۰۰٬۰۰۰ تومان");
    expect(sentence.textContent).toContain("ثبت کار پیگیری ۳ روز بعد");
  });

  it("sends a closed composition, with amounts converted from Toman to Rial", async () => {
    const calls = stubApi({
      "/api/crm/automations": (init) =>
        init?.method === "POST"
          ? { status: 200, body: { automation: RULE } }
          : { status: 200, body: payload() },
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);
    await screen.findByText(/وقتی جابه‌جایی فرصت در قیف/);

    await userEvent.click(screen.getByRole("button", { name: /اتوماسیون تازه/ }));
    await userEvent.type(screen.getByLabelText(/نام قاعده/), "پیگیری مذاکره‌ها");
    // Switching a condition on fills its declared default (10,000,000 Toman).
    await userEvent.click(screen.getByLabelText(/ارزش معامله دست‌کم/));
    await userEvent.selectOptions(await memberSelect(), "member-active");
    await userEvent.click(screen.getByRole("button", { name: /ساخت اتوماسیون/ }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    expect(postBody(calls)).toEqual({
      id: null,
      name: "پیگیری مذاکره‌ها",
      triggerKey: "deal_stage_changed",
      conditions: [{ key: "value_at_least", value: "100000000" }],
      actionKey: "create_follow_up",
      actionConfig: { memberId: "member-active", offsetDays: 1, signal: null },
    });
  });

  it("keeps a refused rule on screen and says why it was refused", async () => {
    stubApi({
      "/api/crm/automations": (init) =>
        init?.method === "POST"
          ? { status: 400, body: { error: "automation_condition_value_invalid" } }
          : { status: 200, body: payload() },
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);
    await screen.findByText(/وقتی جابه‌جایی فرصت در قیف/);

    await userEvent.click(screen.getByRole("button", { name: /اتوماسیون تازه/ }));
    await userEvent.type(screen.getByLabelText(/نام قاعده/), "قاعدهٔ ناقص");
    await userEvent.click(screen.getByRole("button", { name: /ساخت اتوماسیون/ }));

    // The API's code, in the reader's language — and the builder is still open
    // with the name intact, because a refused rule was not saved.
    expect(await screen.findByText("مقدار شرط کامل یا معتبر نیست.")).toBeTruthy();
    expect((screen.getByLabelText(/نام قاعده/) as HTMLInputElement).value).toBe("قاعدهٔ ناقص");
  });

  it("cannot give the Growth action a recipient", async () => {
    const calls = stubApi({
      "/api/crm/automations": (init) =>
        init?.method === "POST"
          ? { status: 200, body: { automation: RULE } }
          : { status: 200, body: payload() },
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);
    await screen.findByText(/وقتی جابه‌جایی فرصت در قیف/);

    await userEvent.click(screen.getByRole("button", { name: /اتوماسیون تازه/ }));
    await userEvent.type(screen.getByLabelText(/نام قاعده/), "خبر به رشد");
    const actionSelect = screen
      .getAllByRole("combobox")
      .find((element) =>
        Array.from((element as HTMLSelectElement).options).some(
          (option) => option.textContent === "اطلاع به رشد و بازاریابی",
        ),
      ) as HTMLSelectElement;
    await userEvent.selectOptions(actionSelect, "notify_growth");
    await waitFor(() => expect(screen.queryByText(/کار به عهدهٔ چه کسی باشد؟/)).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: /ساخت اتوماسیون/ }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    expect(postBody(calls)).toMatchObject({
      actionKey: "notify_growth",
      // The whole boundary in one assertion: no member, no offset, one signal.
      actionConfig: { memberId: null, offsetDays: null, signal: "needs_follow_up" },
    });
  });

  it("explains a run that changed nothing", async () => {
    stubApi({
      "/api/crm/automations": () => ({
        status: 200,
        body: payload([
          run({ id: "run-skip", outcome: "skipped", detail: { reason: "conditions_not_met" } }),
          run({
            id: "run-fail",
            outcome: "failed",
            detail: { error: 'column "stage" does not exist' },
          }),
          run({
            id: "run-growth",
            outcome: "triggered_growth",
            entityType: "lead",
            detail: { signal: "at_risk" },
          }),
        ]),
      }),
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);

    await screen.findByText("اجرا نشد");
    screen.getByText(/شرط‌ها برقرار نبود/);
    screen.getByText(/column "stage" does not exist/);
    screen.getByText("به رشد اطلاع داده شد");
    screen.getByText(/در معرض ریزش/);
  });

  it("turns a rule off and deletes it through the endpoints that own them", async () => {
    const calls = stubApi({
      "/api/crm/automations": () => ({ status: 200, body: payload() }),
      "/api/crm/automations/11111111-1111-4111-8111-111111111111": (init) =>
        init?.method === "PATCH"
          ? { status: 200, body: { automation: { ...RULE, isActive: false } } }
          : { status: 200, body: { result: "deleted" } },
      "/api/crm/members": () => ({ status: 200, body: { members: MEMBERS } }),
    });
    render(<AutomationsSection canConfigure />);
    await screen.findByText(/وقتی جابه‌جایی فرصت در قیف/);

    await userEvent.click(screen.getByRole("button", { name: "خاموش کن" }));
    await waitFor(() =>
      expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe(`/api/crm/automations/${RULE.id}`);
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ isActive: false });
    expect(await screen.findByText(/خاموش شد/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: `حذف اتوماسیون ${RULE.name}` }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.init?.method === "DELETE")?.url).toBe(
      `/api/crm/automations/${RULE.id}`,
    );
  });
});
