// @vitest-environment jsdom
/**
 * Issue #829 completion — one settlement form: the subledger settle dialogs
 * render the shared voucher fields and submit through the shared controller.
 * The register dialog's half is covered in `receipts-payments-section.test`;
 * what only these tests can prove is that the *settle* callers kept their
 * preselected party and balance identifiers while adopting the shared form —
 * and that each side still posts its own payload keys (`customerId` +
 * `idempotencyKey` for A/R, `supplierId` + `clientRequestId` for A/P).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { RECEIVABLES_SIDE } from "./ar-section";
import { PAYABLES_SIDE } from "./ap-section";
import { SubledgerSection } from "./subledger-section";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SUPPLIER_ID = "22222222-2222-4222-8222-222222222222";

function serve() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json({ receipt: { id: "new-1" }, payment: { id: "new-1" } });
    }
    if (url.includes("/api/ledger/ar/customers")) {
      return json({ customers: [{ customerId: CUSTOMER_ID, customerName: "علی رضایی", customerPhone: null, balance: 1500000 }] });
    }
    if (url.includes("/api/ledger/ap/suppliers")) {
      return json({ suppliers: [{ supplierId: SUPPLIER_ID, supplierName: "پخش آسمان", supplierPhone: null, balance: 2000000 }] });
    }
    if (url.includes("/api/ledger/accounts")) {
      return json({ accounts: [] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capability gating", () => {
  it("shows balances but no settle action to a ledger-only viewer", async () => {
    serve();
    render(
      <MoneyProvider unit="rial">
        <SubledgerSection side={RECEIVABLES_SIDE} />
      </MoneyProvider>,
    );
    await screen.findAllByText("علی رضایی");
    expect(screen.queryByRole("button", { name: "دریافت وجه" })).toBeNull();
  });

  it("shows payables but no settle action without the payables capability", async () => {
    serve();
    render(
      <MoneyProvider unit="rial">
        <SubledgerSection side={PAYABLES_SIDE} />
      </MoneyProvider>,
    );
    await screen.findAllByText("پخش آسمان");
    expect(screen.queryByRole("button", { name: "ثبت پرداخت" })).toBeNull();
  });
});

describe("the receivables settle dialog", () => {
  it("keeps its preselected party and balance, and posts the A/R payload through the shared form", async () => {
    const posts = serve();
    render(
      <MoneyProvider unit="rial">
        <SubledgerSection side={RECEIVABLES_SIDE} canSettle />
      </MoneyProvider>,
    );

    fireEvent.click((await screen.findAllByRole("button", { name: "دریافت وجه" }))[0]);
    // The preselected party and the balance this settlement is measured against.
    expect(await screen.findByText("دریافت وجه از علی رضایی")).not.toBeNull();
    expect(screen.queryByText("مانده فعلی:")).not.toBeNull();
    // The shared fields: prefilled amount, side-labeled method and date.
    expect(screen.queryByText("روش دریافت")).not.toBeNull();
    expect(screen.queryByText("تاریخ دریافت (اختیاری)")).not.toBeNull();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ثبت دریافت" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe("/api/ledger/ar/receipts");
    expect(posts[0].body).toMatchObject({ customerId: CUSTOMER_ID, amount: 1500000, method: "cash" });
    expect(typeof posts[0].body.idempotencyKey).toBe("string");
  });
});

describe("the payables settle dialog", () => {
  it("keeps its preselected party and posts the A/P payload with an intent key", async () => {
    const posts = serve();
    render(
      <MoneyProvider unit="rial">
        <SubledgerSection side={PAYABLES_SIDE} canSettle />
      </MoneyProvider>,
    );

    fireEvent.click((await screen.findAllByRole("button", { name: "ثبت پرداخت" }))[0]);
    expect(await screen.findByText("پرداخت به پخش آسمان")).not.toBeNull();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ثبت پرداخت" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe("/api/ledger/ap/payments");
    expect(posts[0].body).toMatchObject({ supplierId: SUPPLIER_ID, amount: 2000000, method: "cash" });
    expect(typeof posts[0].body.clientRequestId).toBe("string");
    expect(posts[0].body).not.toHaveProperty("idempotencyKey");
  });
});
