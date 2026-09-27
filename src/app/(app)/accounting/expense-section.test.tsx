// @vitest-environment jsdom

/**
 * The receipt-photo upload control (migration 0177): a chosen photo is sent
 * to `/api/ai/receipt-ocr`, and a successful extraction both prefills the
 * form and remembers the resulting Media asset so `submit` attaches it as
 * the expense's `receiptAssetId` — the same asset id the OCR route itself
 * already stored (deduped by SHA-256) in the canonical Media Library. A
 * failed extraction must degrade to plain manual entry, never block it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseSection } from "./expense-section";
import type { AccountRow, Runner } from "./accounting-manager";

afterEach(cleanup);

const ACCOUNTS: AccountRow[] = [
  { id: "acc-expense-1", code: "5001", name: "خرید ملزومات", type: "expense", parent_code: null },
  { id: "acc-cash-1", code: "1001", name: "صندوق", type: "asset", parent_code: null },
];

const EMPTY_LIST = { expenses: [], hasMore: false, totalAmount: 0, totalCount: 0 };

function receiptFile() {
  return new File(["fake-bytes"], "receipt.jpg", { type: "image/jpeg" });
}

beforeEach(() => {
  // jsdom's FileReader doesn't decode real JPEG bytes — it just needs to
  // resolve asynchronously so the component can move on to the fetch.
  vi.stubGlobal(
    "FileReader",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result = "data:image/jpeg;base64,ZmFrZQ==";
      readAsDataURL() {
        setTimeout(() => this.onload?.(), 0);
      }
    },
  );
});

function renderSection(run: Runner = vi.fn()) {
  return render(<ExpenseSection accounts={ACCOUNTS} busy={false} run={run} refreshKey={0} />);
}

async function uploadReceipt() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [receiptFile()] } });
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ExpenseSection — receipt photo upload", () => {
  it("uploads a receipt photo, extracts fields, and prefills empty ones without overwriting typed values", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/ledger/expenses")) return { ok: true, status: 200, json: async () => EMPTY_LIST };
      if (url === "/api/ai/receipt-ocr") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fields: {
              vendor: "فروشگاه ملزومات",
              expenseDate: "1403-05-01",
              amount: 1_500_000,
              memo: "خرید لوازم اداری",
              suggestedAccountCode: "5001",
            },
            asset: { id: "asset-receipt-1", fileName: "receipt.jpg" },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSection();
    await uploadReceipt();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai/receipt-ocr", expect.anything()));
    await screen.findByText(/receipt\.jpg/);

    expect((screen.getByPlaceholderText("نام طرف حساب") as HTMLInputElement).value).toBe("فروشگاه ملزومات");
    expect((screen.getByPlaceholderText("شرح و دلیل ثبت هزینه") as HTMLInputElement).value).toBe("خرید لوازم اداری");
    // 1,500,000 Rial → 150,000 Toman (the default display unit with no MoneyProvider),
    // shown through PersianNumberInput's own Persian-digit/thousands formatting.
    expect((screen.getByPlaceholderText("۰") as HTMLInputElement).value).toBe("۱۵۰٬۰۰۰");
    // The OCR's suggested account code (5001) matched a real expense account.
    expect(screen.getByRole("button", { name: "دسته هزینه" }).textContent).toContain("خرید ملزومات");
  });

  it("shows an error and leaves the form untouched when extraction fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/ledger/expenses")) return { ok: true, status: 200, json: async () => EMPTY_LIST };
      return { ok: false, status: 422, json: async () => ({ error: "receipt_unreadable", message: "متن رسید خوانا نبود." }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSection();
    await uploadReceipt();

    await screen.findByText("متن رسید خوانا نبود.");
    expect((screen.getByPlaceholderText("نام طرف حساب") as HTMLInputElement).value).toBe("");
  });

  it("includes the extracted asset's id as receiptAssetId when the expense is submitted", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/ledger/expenses")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          expect(body.receiptAssetId).toBe("asset-receipt-1");
          return { ok: true, status: 201, json: async () => ({ expense: { id: "exp-1" } }) };
        }
        return { ok: true, status: 200, json: async () => EMPTY_LIST };
      }
      if (url === "/api/ai/receipt-ocr") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fields: {
              vendor: "فروشگاه ملزومات",
              expenseDate: "1403-05-01",
              amount: 1_500_000,
              memo: "خرید لوازم اداری",
              suggestedAccountCode: "5001",
            },
            asset: { id: "asset-receipt-1", fileName: "receipt.jpg" },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const run: Runner = async (fn) => {
      const { ok } = await fn();
      return ok;
    };
    renderSection(run);

    // The OCR prefill covers everything except the payment account (there is
    // no "paid from" signal on a receipt photo) — pick one through the real
    // SearchableSelect so `validate()` is satisfied the same way a person
    // filling the form out would satisfy it.
    await user.click(screen.getByRole("button", { name: "حساب پرداخت" }));
    await user.click(await screen.findByRole("option", { name: "1001 — صندوق" }));

    await uploadReceipt();
    await screen.findByText(/receipt\.jpg/);

    const form = document.querySelector("form") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/ledger/expenses", expect.objectContaining({ method: "POST" }));
  });
});
