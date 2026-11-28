/**
 * Issue #901, Wave 2 — campaign cashback posting rules.
 *
 * A marketing reward is a real liability with its own lifecycle, and it is
 * **not** a sales return and **not** store credit. Before this file the only
 * way to post "money we owe a customer" was `loyalty.store_credit_issued`
 * (Dr 4400 برگشت از فروش / Cr 2410 اعتبار فروشگاهی) — a refund-shaped entry.
 * Posting a campaign promise through it would report marketing spend as
 * negative revenue and mix the cashback obligation into the store-credit
 * balance a customer can also spend. Both are wrong, so the treatment here is
 * its own:
 *
 *   growth.cashback_earned     Dr 5600 بازاریابی و تبلیغات
 *                              Cr 2445 بازگشت وجه تبلیغاتی
 *   growth.cashback_redeemed   Dr 2445
 *                              Cr 1100 صندوق / 1110 بانک
 *   growth.cashback_reversed   Dr 2445 / Cr 5600   (refund, unspent part)
 *   growth.cashback_expired    Dr 2445 / Cr 5600   (unspent value lapses)
 *   growth.cashback_tender_restored
 *                              Dr 4400 برگشت از فروش (+ Dr 1106 VAT)
 *                              Cr 2445            (a reward spent at the till
 *                                                  given back by a return)
 *
 * The two till legs are worth stating, because they are where this treatment
 * differs from a cash payout. A sale paid partly with a reward debits 2445 in
 * the **sale's own payment entry** (`ledger-service.ts`), so no
 * `growth.cashback_redeemed` entry is posted for it — posting a payout as well
 * would debit the liability twice. When that sale is returned, the customer is
 * given the reward back on their wallet rather than in cash, so the return's
 * contra-revenue debit is settled against 2445 (this rule) and the return's
 * cash-refund capacity excludes the reward portion
 * (`customer-return-service.ts`). The debit side is 4400 because this is an
 * ordinary sales return of the bill's revenue; the credit side is the reward
 * liability, which is what keeps a returned cashback sale out of the cash
 * drawer and out of store credit (2410).
 *
 * Recognising the expense at grant (not at redemption) is deliberate: the
 * moment a campaign promises a reward for a settled sale, the business owes
 * it, and a month whose rewards were granted but not yet spent must show that
 * obligation. Redemption then moves a liability, not an expense — so the P&L
 * can never show the same reward twice.
 *
 * Every rule is registered on the shared domain-event engine, so the entries
 * pass the same fiscal-period lock, exact-BigInt balancing and
 * (source, posting_kind) idempotency as every other auto-posted document.
 * Each reward event is its own source id, so two rewards never collide.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

const PAYOUT_ACCOUNT_CODE: Record<"cash" | "bank", string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
};

interface CashbackAmountPayload {
  amount: RialText;
  /** The branch business date, resolved before the financial action starts. */
  entryDate?: string | null;
  campaignId?: string | null;
  customerId?: string | null;
}

interface CashbackRestorePayload {
  /** The gross reward value the customer gets back. */
  amount: RialText;
  /** The VAT share of that value, reversed with the revenue. */
  tax?: RialText;
  entryDate?: string | null;
  customerId?: string | null;
  orderId?: string | null;
}

registerPostingRule("growth.cashback_earned", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CashbackAmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.marketingExpense,
    WELL_KNOWN_CODES.cashbackPayable,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.marketingExpense)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cashbackPayable)!, debit: ZERO, credit: payload.amount },
    ],
    entryDate: payload.entryDate ?? null,
    memo: "تعهد بازگشت وجه کمپین — پاداش فروش",
    postingKind: "growth_cashback_earned",
  };
});

registerPostingRule("growth.cashback_redeemed", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CashbackAmountPayload & { payoutMethod?: "cash" | "bank" };
  if (rialBigInt(payload.amount) === 0n) return null;

  const payoutCode = PAYOUT_ACCOUNT_CODE[payload.payoutMethod ?? "cash"] ?? WELL_KNOWN_CODES.cash;
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cashbackPayable,
    payoutCode,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cashbackPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(payoutCode)!, debit: ZERO, credit: payload.amount },
    ],
    entryDate: payload.entryDate ?? null,
    memo: "پرداخت بازگشت وجه کمپین به مشتری",
    postingKind: "growth_cashback_redeemed",
  };
});

registerPostingRule("growth.cashback_reversed", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CashbackAmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cashbackPayable,
    WELL_KNOWN_CODES.marketingExpense,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cashbackPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.marketingExpense)!, debit: ZERO, credit: payload.amount },
    ],
    entryDate: payload.entryDate ?? null,
    memo: "برگشت پاداش کمپین — مرجوعی یا ابطال فروش",
    postingKind: "growth_cashback_reversed",
  };
});

registerPostingRule("growth.cashback_tender_restored", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CashbackRestorePayload;
  const gross = rialBigInt(payload.amount);
  if (gross === 0n) return null;
  const tax = rialBigInt(payload.tax ?? ZERO);
  // A tax share larger than the value it is part of is a caller bug, and
  // posting it would credit more revenue back than was reversed.
  if (tax < 0n || tax > gross) throw new Error("invalid_cashback_restore_tax");
  const net = gross - tax;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.salesReturns,
    WELL_KNOWN_CODES.vatPayable,
    WELL_KNOWN_CODES.cashbackPayable,
  ]);

  return {
    lines: [
      {
        accountId: accounts.get(WELL_KNOWN_CODES.salesReturns)!,
        debit: net.toString() as RialText,
        credit: ZERO,
      },
      // The bill's tax share is reversed with its revenue; a tax-free sale
      // posts no VAT line at all rather than a zero one.
      ...(tax > 0n
        ? [
            {
              accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!,
              debit: tax.toString() as RialText,
              credit: ZERO,
            },
          ]
        : []),
      { accountId: accounts.get(WELL_KNOWN_CODES.cashbackPayable)!, debit: ZERO, credit: payload.amount },
    ],
    entryDate: payload.entryDate ?? null,
    memo: "برگشت فروش پرداخت‌شده با پاداش کمپین — بازگشت به کیف پول مشتری",
    postingKind: "growth_cashback_tender_restored",
  };
});

registerPostingRule("growth.cashback_expired", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CashbackAmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cashbackPayable,
    WELL_KNOWN_CODES.marketingExpense,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cashbackPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.marketingExpense)!, debit: ZERO, credit: payload.amount },
    ],
    entryDate: payload.entryDate ?? null,
    memo: "انقضای بازگشت وجه کمپین — ماندهٔ استفاده‌نشده",
    postingKind: "growth_cashback_expired",
  };
});
