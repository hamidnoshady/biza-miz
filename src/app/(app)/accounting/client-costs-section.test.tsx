// @vitest-environment jsdom

/**
 * The reimbursable-cost register's refusals — the half a pure unit test cannot see.
 *
 * `agency-reimbursable-cost.test.ts` pins the vocabulary, `-guard.test.ts` pins the
 * routes' error mapping and `integration/agency-{reimbursable-costs,recharge,
 * cost-policy}.integration.test.ts` pin the postings. What is left, and what only a
 * render can catch, is whether the screen *says* what the service does:
 *
 *  1. **A default is not a decision.** While `policy.stored` is false the card must
 *     read «هنوز انتخاب نشده» and name the fallback separately. Rendering the
 *     fallback alone would show a policy the software supplied as one the business
 *     adopted — the exact confusion `AgencyCostPolicyState.stored` exists to prevent.
 *  2. **The form sends nothing until the member overrides.** «پیروی از سیاست» must
 *     omit `presentation` from the body entirely, so the service resolves the policy.
 *     An empty string would be a value the service has to reject, and a pre-filled
 *     account would be §D's forbidden inference from the row.
 *  3. **The ledger is the only answer about where money went.** The table prints the
 *     `accounts.debitCode` the API served rather than mapping `presentation` back to
 *     a code locally.
 *  4. **A recharge cannot half-happen.** Unposted and already-recharged costs are not
 *     selectable and say why, and a selection spanning two clients is refused before
 *     it is sent — one invoice bills one client.
 *  5. **Navigation is not authorization, and neither is a hidden control.** A member
 *     who may read but not move money sees the figures and no buttons.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/crm/customer-search", () => ({
  CustomerSearchField: ({
    onPick,
  }: {
    onPick: (match: { id: string; name: string; phone: string | null }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onPick({ id: CLIENT_A, name: "کارفرمای الف", phone: null })}
    >
      انتخاب کارفرما
    </button>
  ),
}));

import { ClientCostsSection } from "./client-costs-section";
import { toPersianDigits } from "@/lib/digits";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const OPTIONS = [
  {
    value: "net",
    label: "قابل بازدریافت از کارفرما (خالص) — به حساب ۱۲۷۰",
    hint: "پول کارفرماست و تا بازدریافت، طلب از اوست.",
  },
  {
    value: "gross",
    label: "هزینهٔ خود آژانس (ناخالص) — به حساب ۵۱۹۷",
    hint: "بهای تمام‌شدهٔ آژانس است و بازدریافت، درآمد آن.",
  },
];

function cost(over: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    costNumber: "RC-001",
    partyId: CLIENT_A,
    clientName: "کارفرمای الف",
    projectId: null,
    projectName: null,
    vendorName: "رسانهٔ آفتاب",
    description: "خرید فضای تبلیغاتی آبان",
    amountRial: 5_000_000,
    spentOn: "2026-10-05",
    presentation: "net",
    settledBy: "payable",
    note: "",
    entryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    posted: true,
    accounts: { debitCode: "1270", creditCode: "2140" },
    passThrough: true,
    rechargedOrderId: null,
    rechargedBy: null,
    rechargedByName: "",
    recharged: false,
    createdAt: "2026-10-05T08:00:00.000Z",
    updatedAt: "2026-10-05T08:00:00.000Z",
    ...over,
  };
}

type Stub = {
  costs?: unknown[];
  policy?: { presentation: "net" | "gross"; stored: boolean; updatedAt: string | null };
};

/** Captures every write so a test can read the body the service would receive. */
function stubApi(stub: Stub = {}) {
  const writes: { url: string; body: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init && init.method && init.method !== "GET") {
      writes.push({ url: target, body: String(init.body ?? "") });
      const reply = target.endsWith("/recharge")
        ? { recharge: { orderId: "e1", orderNumber: 1042, totalRial: 5_000_000 } }
        : target.endsWith("/policy")
          ? { policy: stub.policy ?? { presentation: "net", stored: true, updatedAt: null } }
          : { cost: cost() };
      return { ok: true, status: 201, json: async () => reply } as unknown as Response;
    }
    // The policy URL is the more specific prefix, so it is matched first.
    if (target.includes("/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          policy: stub.policy ?? { presentation: "net", stored: true, updatedAt: null },
          options: OPTIONS,
          fallback: "net",
        }),
      } as unknown as Response;
    }
    if (target.startsWith("/api/workspace/projects")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ projects: [{ id: "p1", name: "کمپین نوروز" }] }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ costs: stub.costs ?? [cost()] }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return writes;
}

const EVERY_CAPABILITY = { canRecord: true, canRecharge: true, canSetPolicy: true };

describe("ClientCostsSection — the policy the business chose", () => {
  it("names an unchosen policy as unchosen, and the fallback separately", async () => {
    stubApi({ policy: { presentation: "net", stored: false, updatedAt: null } });
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    expect(await screen.findByText("هنوز انتخاب نشده")).toBeTruthy();
    // The fallback is named as a placeholder, in a sentence that says it is not a
    // decision — never as the badge a chosen policy wears.
    const card = screen.getByText("هنوز انتخاب نشده").closest("div[class*='space-y']");
    expect(card?.textContent).toContain("تا وقتی این کسب‌وکار سیاستی انتخاب نکند");
    expect(card?.textContent).toContain(OPTIONS[0].label);
    expect(screen.queryByText("انتخاب‌شده")).toBeNull();
  });

  it("shows a chosen policy as chosen, in the API's own words", async () => {
    stubApi({ policy: { presentation: "gross", stored: true, updatedAt: "2026-09-01T00:00:00.000Z" } });
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    expect(await screen.findByText(OPTIONS[1].label)).toBeTruthy();
    expect(screen.queryByText("هنوز انتخاب نشده")).toBeNull();
    // The words come from the route, so the screen cannot drift from the ledger's.
    expect(screen.getByText(OPTIONS[1].hint)).toBeTruthy();
  });

  it("warns that a policy change does not reach the ledger backwards", async () => {
    stubApi();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);
    await screen.findByText("هزینه‌های کارفرما");
    expect(screen.getByText(/تغییر سیاست به گذشته نمی‌رسد/)).toBeTruthy();
  });
});

describe("ClientCostsSection — where the money landed", () => {
  it("prints the debit account the API served, for both treatments", async () => {
    stubApi({
      costs: [
        cost({ id: "row-net", costNumber: "RC-001", accounts: { debitCode: "1270", creditCode: "2140" } }),
        cost({
          id: "row-gross",
          costNumber: "RC-002",
          presentation: "gross",
          passThrough: false,
          accounts: { debitCode: "5197", creditCode: "1100" },
        }),
      ],
    });
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await screen.findByText(toPersianDigits("RC-001"));
    expect(screen.getByText(toPersianDigits("1270"))).toBeTruthy();
    expect(screen.getByText(toPersianDigits("5197"))).toBeTruthy();
  });
});

describe("ClientCostsSection — recording a cost", () => {
  it("sends no presentation while the member follows the policy", async () => {
    const writes = stubApi();
    const user = userEvent.setup();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await user.click(await screen.findByText("ثبت هزینه"));
    await user.click(screen.getByText("انتخاب کارفرما"));
    await user.type(screen.getByPlaceholderText("مثلاً خرید فضای تبلیغاتی آبان"), "پرداخت چاپ بنر");
    await user.type(screen.getByLabelText("مبلغ به ریال"), "5000000");
    await user.type(screen.getByLabelText("تاریخ پرداخت"), "2026-10-05");
    await user.click(screen.getByText("ثبت و صدور سند"));

    await waitFor(() => expect(writes.length).toBe(1));
    const body = JSON.parse(writes[0].body) as Record<string, unknown>;
    // The absence *is* the assertion: the service resolves the policy, and a screen
    // that sent an account would be inferring the treatment from the row.
    expect("presentation" in body).toBe(false);
    expect(body.partyId).toBe(CLIENT_A);
    expect(body.description).toBe("پرداخت چاپ بنر");
    expect(body.settledBy).toBe("payable");
  });

  it("sends the treatment only when the member overrides the policy", async () => {
    const writes = stubApi({ policy: { presentation: "net", stored: true, updatedAt: null } });
    const user = userEvent.setup();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await user.click(await screen.findByText("ثبت هزینه"));
    await user.click(screen.getByText("انتخاب کارفرما"));
    await user.type(screen.getByPlaceholderText("مثلاً خرید فضای تبلیغاتی آبان"), "پرداخت چاپ بنر");
    await user.type(screen.getByLabelText("مبلغ به ریال"), "5000000");
    await user.type(screen.getByLabelText("تاریخ پرداخت"), "2026-10-05");
    await user.selectOptions(screen.getByLabelText("ارائهٔ درآمد"), "gross");
    await user.click(screen.getByText("ثبت و صدور سند"));

    await waitFor(() => expect(writes.length).toBe(1));
    expect((JSON.parse(writes[0].body) as Record<string, unknown>).presentation).toBe("gross");
  });

  it("refuses to send a cost with no client, no description or no date", async () => {
    const writes = stubApi();
    const user = userEvent.setup();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await user.click(await screen.findByText("ثبت هزینه"));
    await user.type(screen.getByLabelText("مبلغ به ریال"), "5000000");
    await user.click(screen.getByText("ثبت و صدور سند"));

    expect(await screen.findByText("کارفرما، شرح و تاریخ پرداخت لازم است.")).toBeTruthy();
    expect(writes).toHaveLength(0);
  });
});

describe("ClientCostsSection — recharging", () => {
  it("keeps an unposted and an already-recharged cost out, and says why", async () => {
    stubApi({
      costs: [
        cost({ id: "row-ready", costNumber: "RC-001" }),
        cost({ id: "row-pending", costNumber: "RC-002", posted: false, entryId: null }),
        cost({
          id: "row-done",
          costNumber: "RC-003",
          recharged: true,
          rechargedOrderId: "e9",
          rechargedByName: "حسابدار",
        }),
      ],
    });
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await screen.findByText(toPersianDigits("RC-001"));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes[0].disabled).toBe(false);
    // The reason is on the same row as the disabled box, so it is not a mystery.
    expect(boxes[1].disabled).toBe(true);
    expect(boxes[1].closest("tr")?.textContent).toContain("هنوز در دفتر ثبت نشده");
    expect(boxes[2].disabled).toBe(true);
    expect(boxes[2].closest("tr")?.textContent).toContain("بازدریافت شده");
  });

  it("refuses one invoice for two clients before it is sent", async () => {
    const writes = stubApi({
      costs: [
        cost({ id: "row-a", costNumber: "RC-001" }),
        cost({ id: "row-b", costNumber: "RC-002", partyId: CLIENT_B, clientName: "کارفرمای ب" }),
      ],
    });
    const user = userEvent.setup();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await screen.findByText(toPersianDigits("RC-001"));
    const boxes = within(screen.getByRole("table")).getAllByRole("checkbox");
    await user.click(boxes[0]);
    await user.click(boxes[1]);

    expect(
      await screen.findByText(/هزینه‌ها از دو کارفرما انتخاب شده‌اند/),
    ).toBeTruthy();
    const button = screen.getByText("صدور فاکتور بازدریافت") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(writes).toHaveLength(0);
  });

  it("bills one client's costs and reports the invoice it raised", async () => {
    const writes = stubApi({ costs: [cost({ id: "row-a" }), cost({ id: "row-b", costNumber: "RC-002" })] });
    const user = userEvent.setup();
    render(<ClientCostsSection {...EVERY_CAPABILITY} />);

    await screen.findByText(toPersianDigits("RC-001"));
    const boxes = within(screen.getByRole("table")).getAllByRole("checkbox");
    await user.click(boxes[0]);
    await user.click(boxes[1]);
    await user.click(screen.getByText("صدور فاکتور بازدریافت"));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].url).toContain("/api/agency/reimbursable-costs/recharge");
    expect(JSON.parse(writes[0].body)).toEqual({ costIds: ["row-a", "row-b"] });
    expect(await screen.findByText(/فاکتور بازدریافت شمارهٔ/)).toBeTruthy();
  });
});

describe("ClientCostsSection — reading is not moving money", () => {
  it("shows a member with ledger.view alone the figures and no controls", async () => {
    stubApi();
    render(<ClientCostsSection canRecord={false} canRecharge={false} canSetPolicy={false} />);

    // The register is still readable — that is what ledger.view buys.
    expect(await screen.findByText(toPersianDigits("RC-001"))).toBeTruthy();
    expect(screen.getByText(toPersianDigits("1270"))).toBeTruthy();
    // …and nothing on it can be acted on.
    expect(screen.queryByText("ثبت هزینه")).toBeNull();
    expect(screen.queryByText("تغییر سیاست")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers the recharge to a member who may record but not invoice", async () => {
    stubApi();
    render(<ClientCostsSection canRecord canRecharge={false} canSetPolicy />);

    expect(await screen.findByText("ثبت هزینه")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
