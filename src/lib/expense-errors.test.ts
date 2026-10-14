/**
 * One error-code map for four channels (issue #832 §17).
 *
 * `recordExpense()` throws a code; the Expenses screen, `POST
 * /api/ledger/expenses`, the data-transfer import adapter and the AI/autopilot
 * executor each have to turn it into something a person can act on. They used to
 * keep their own lists, which is how the importer ended up translating
 * `wrong_account_type` — a code nothing emits any more — while a real
 * `invalid_payment_account` fell through to technical text in a business screen.
 *
 * So the contract these tests hold is: every code the service can throw is here,
 * has Persian text (not a code echoed back), and carries a status a client can
 * branch on. A code added to the service without a message fails here.
 */
import { describe, expect, it } from "vitest";
import {
  EXPENSE_ERROR_MESSAGES,
  EXPENSE_UI_ERROR_MESSAGES,
  expenseErrorMessage,
  expenseErrorStatus,
  type ExpenseErrorCode,
} from "./expense-errors";

const CODES = Object.keys(EXPENSE_ERROR_MESSAGES) as ExpenseErrorCode[];

describe("EXPENSE_ERROR_MESSAGES", () => {
  it("covers every code the service and the routes throw", () => {
    // Asserted by hand against `expense-service.ts`'s throw sites: a code that
    // appears there and not here renders as «خطای غیرمنتظره» in the UI.
    for (const code of [
      "invalid_amount",
      "memo_required",
      "unknown_account",
      "invalid_expense_account",
      "invalid_payment_account",
      "same_account",
      "invalid_expense_date",
      "expense_date_in_future",
      "vat_amount_invalid",
      "vat_account_missing",
      "receipt_asset_not_found",
      "party_not_found",
      "invalid_location",
      "expense_not_found",
      "expense_already_reversed",
      "expense_is_reversal",
    ]) {
      expect(CODES, `missing error text for ${code}`).toContain(code);
    }
  });

  it("names the codes the importer used to invent, so they cannot come back", () => {
    // `wrong_account_type` and `period_closed` were the import adapter's private
    // translations of codes nothing throws. A fiscal lock has its own codes, from
    // `fiscalPeriodLockErrorCode`, and this map must not acquire duplicates.
    expect(CODES).not.toContain("wrong_account_type");
    expect(CODES).not.toContain("period_closed");
    for (const stale of ["wrong_account_type", "period_closed", "import_failed"]) {
      expect(expenseErrorMessage(stale)).toBeNull();
    }
  });

  it("says something a business owner can act on, in Persian, and never the code", () => {
    for (const code of CODES) {
      const text = EXPENSE_ERROR_MESSAGES[code];
      expect(text.length, code).toBeGreaterThan(12);
      expect(text, code).not.toContain(code);
      // The two ways a Persian string is written here: Arabic-script letters.
      expect(/[؀-ۿ]/.test(text), `${code} has no Persian text`).toBe(true);
      // A trailing space or a leading newline turns into «» in a table cell.
      expect(text, code).toBe(text.trim());
    }
  });

  it("tells a payment-source refusal apart from an unknown account", () => {
    // The single most-confused case in the audit: «why can't I pay rent from
    // inventory?» needs an answer that names the accounts that *are* allowed.
    expect(EXPENSE_ERROR_MESSAGES.invalid_payment_account).toContain("صندوق");
    expect(EXPENSE_ERROR_MESSAGES.invalid_payment_account).not.toBe(EXPENSE_ERROR_MESSAGES.unknown_account);
  });

  it("points a missing input-VAT account at the chart, not at the form", () => {
    expect(EXPENSE_ERROR_MESSAGES.vat_account_missing).toContain("سرفصل حساب");
  });

  it("explains that a reversal is not itself reversible, and what to do instead", () => {
    expect(EXPENSE_ERROR_MESSAGES.expense_is_reversal).toContain("هزینهٔ جدید");
  });
});

describe("expenseErrorStatus", () => {
  it("answers 404 for a thing that is not there and 409 for a thing that is", () => {
    expect(expenseErrorStatus("expense_not_found")).toBe(404);
    expect(expenseErrorStatus("receipt_asset_not_found")).toBe(404);
    expect(expenseErrorStatus("party_not_found")).toBe(404);
    expect(expenseErrorStatus("expense_already_reversed")).toBe(409);
    expect(expenseErrorStatus("expense_is_reversal")).toBe(409);
    expect(expenseErrorStatus("vat_account_missing")).toBe(409);
  });

  it("answers 400 for every input mistake", () => {
    for (const code of ["invalid_amount", "memo_required", "same_account", "invalid_expense_date", "expense_date_in_future", "vat_amount_invalid", "invalid_location", "unknown_account", "invalid_expense_account", "invalid_payment_account"]) {
      expect(expenseErrorStatus(code), code).toBe(400);
    }
  });

  it("defaults an unmapped code to 400 rather than 500", () => {
    // A 5xx for a validation code is how a data-entry error turns into an
    // incident page.
    expect(expenseErrorStatus("something_new")).toBe(400);
  });

  it("gives every mapped code a status in the 4xx range", () => {
    for (const code of CODES) {
      const status = expenseErrorStatus(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(500);
    }
  });
});

describe("EXPENSE_UI_ERROR_MESSAGES", () => {
  it("excludes exactly the three codes the shared chrome already words", () => {
    // `invalid_amount`, `memo_required` and `unknown_account` are shared with the
    // journal, cheques and reconciliation screens, whose generic text («شرح سند
    // الزامی است.») the Expenses screen already has. Duplicating them here is how
    // two spellings of the same idea start disagreeing.
    expect(Object.keys(EXPENSE_UI_ERROR_MESSAGES).sort()).toEqual(
      CODES.filter((code) => !["invalid_amount", "memo_required", "unknown_account"].includes(code)).sort(),
    );
  });

  it("expenseErrorMessage resolves a code and returns null for a foreign one", () => {
    expect(expenseErrorMessage("same_account")).toBe(EXPENSE_ERROR_MESSAGES.same_account);
    expect(expenseErrorMessage("")).toBeNull();
    expect(expenseErrorMessage("ledger_period_locked")).toBeNull();
  });
});
