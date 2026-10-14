/**
 * Issue #839 Wave 2/4 — the automotive trade's posting rules, registered
 * against Wave 1's domain-event/posting engine.
 *
 * A car is finished goods whose *acquisition* is as much an accounting event
 * as its sale, so this module registers both halves:
 *
 *   - `automotive.vehicle_acquired`: Debit «موجودی خودرو» (1370) for the base
 *     purchase price; Credit whatever actually settled it — payable (2100) for
 *     a bought-on-terms car, cash (1100) or bank (1110) for one paid at
 *     hand-over, «تعهد بابت معاوضه خودرو» (2465) for a trade-in (the
 *     dealership owes the customer for the car it took), and the opening
 *     balance equity (3900) for opening stock, which is a starting position,
 *     not a purchase (§4's "opening vehicle stock ... no fake sales or
 *     purchases").
 *   - `automotive.vehicle_cost`: one vehicle's own money, with §5's explicit
 *     decision taken by the caller and honoured here: `capitalized` debits
 *     1370 (it becomes part of the car's basis), `period_expense` debits
 *     «هزینه بازسازی و آماده‌سازی خودرو» (5195). The credit side is the
 *     settlement the caller names — cash, bank, payable, or `clearing`, which
 *     releases «هزینه‌های حمل و ترخیص خودرو (واسط)» (1375): freight and
 *     customs paid to a forwarder *before* the car is assigned are parked
 *     there, and assigning them to a vehicle is precisely what moves them out.
 *   - `automotive.vehicle_cost_void`: the mirror of the row being voided. A
 *     cost is voided, never edited (migration 0212), so a wrong
 *     reconditioning figure leaves *two* ledger facts — what was wrongly
 *     recorded and the reversal — rather than a mutated one nobody can audit.
 *   - `automotive.deposit_received` / `automotive.deposit_refunded`: a
 *     reservation deposit is money received against a future sale, so it
 *     lands on the *shared* customer-advance liability (2430
 *     «پیش‌دریافت از مشتری», `WELL_KNOWN_CODES.layawayDeposit`) and comes back
 *     off it on refund. Never revenue: §7 says so, and a refunded deposit
 *     would otherwise have to un-earn revenue, which is not a thing.
 *   - `automotive.sale_revenue`: Debit the payment accounts by tender (the
 *     same `PAYMENT_ACCOUNT_CODE` split every retail sale uses), plus the
 *     deposit actually applied to this invoice — which *clears* 2430 rather
 *     than adding a new asset, because that money was received weeks ago;
 *     Credit 4590 «فروش خودرو» for the net and 2200 for VAT.
 *   - `automotive.sale_cogs`: Debit 5194 «بهای تمام‌شده خودروی فروخته‌شده» /
 *     Credit 1370 for the unit's **frozen effective cost** — the number the
 *     sale wrote into `automotive_vehicle_attributes.frozen_effective_cost_rial`
 *     in the same transaction, so a later reconditioning cost can never
 *     rewrite what the books already recorded for this car.
 *
 * The revenue/COGS split is the same "two entries, not one" discipline Phase 7
 * chose for F&B order payments and `watch-posting-rules.ts` reused: one rule
 * that reports the sale, one that reports the cost it consumed. A car with no
 * recorded cost posts no COGS (the event is still recorded), exactly as a
 * zero-total warranty repair posts no revenue.
 *
 * VAT is never computed here — the caller passes the `net`/`vat` split the
 * business's own configured rules produced, the same contract every other
 * retail posting rule works to.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

const ZERO = "0" as RialText;

/** The account a tender settles into — the same split `watch-posting-rules.ts` uses. */
const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

/**
 * How a deposit was received. A deposit carries the repo's `payment_method`
 * enum (migration 0001), which is more granular than the settlement
 * abstraction: card, card-to-card and online are all *bank* money by the time
 * the ledger sees them.
 */
export const VEHICLE_DEPOSIT_ACCOUNT_BY_METHOD: Record<string, string> = {
  cash: WELL_KNOWN_CODES.cash,
  card: WELL_KNOWN_CODES.bankClearing,
  card_to_card: WELL_KNOWN_CODES.bankClearing,
  online: WELL_KNOWN_CODES.bankClearing,
};

/**
 * What paid for the acquisition or the cost. Not the tender queue: these are
 * the dealership's own obligations, and `clearing` exists so a freight or
 * customs cost paid through 1375 before the car was assigned does not have to
 * invent a second cash outflow when it is capitalized.
 */
export type VehicleSettlement =
  | "cash"
  | "bank"
  | "payable"
  | "clearing"
  | "opening_equity"
  | "trade_in";

const SETTLEMENT_ACCOUNT_CODE: Record<VehicleSettlement, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
  payable: WELL_KNOWN_CODES.accountsPayable,
  clearing: WELL_KNOWN_CODES.vehicleLandedCostClearing,
  opening_equity: WELL_KNOWN_CODES.openingEquity,
  trade_in: WELL_KNOWN_CODES.vehicleTradeInPayable,
};

interface VehicleAcquiredPayload {
  serialId: string;
  stockNumber: string;
  baseCost: RialText;
  settlement: VehicleSettlement;
}

/**
 * §4 — a car enters stock. `null` for a car acquired at no recorded cost
 * (a dealer's consignment or a gift): the event is still recorded, because the
 * vehicle exists and the audit trail should say so, but there is no
 * consideration to book. Such a car cannot be sold for COGS until a cost is
 * recorded, which the sale path refuses — the same discipline
 * `sellSerializedUnit` applies to a watch with no `unit_cost`.
 */
registerPostingRule("automotive.vehicle_acquired", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as VehicleAcquiredPayload;
  if (rialBigInt(payload.baseCost) === 0n) return null;

  const settlementCode = SETTLEMENT_ACCOUNT_CODE[payload.settlement];
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.vehicleInventory,
    settlementCode,
  ]);

  return {
    lines: [
      {
        accountId: accounts.get(WELL_KNOWN_CODES.vehicleInventory)!,
        debit: payload.baseCost,
        credit: ZERO,
      },
      { accountId: accounts.get(settlementCode)!, debit: ZERO, credit: payload.baseCost },
    ],
    memo: `ورود خودرو به موجودی${payload.stockNumber ? ` — ${payload.stockNumber}` : ""}`,
    postingKind: "automotive_vehicle_acquired",
  };
});

interface VehicleCostPayload {
  serialId: string;
  costId: string;
  stockNumber: string;
  amount: RialText;
  posting: "capitalized" | "period_expense";
  settlement: VehicleSettlement;
}

/** §5 — the debit side of a vehicle cost is its `posting` decision, verbatim. */
function vehicleCostLines(
  accounts: Map<string, string>,
  payload: VehicleCostPayload,
): PostingResult["lines"] {
  const debitCode =
    payload.posting === "capitalized"
      ? WELL_KNOWN_CODES.vehicleInventory
      : WELL_KNOWN_CODES.vehicleReconditioningExpense;
  const creditCode = SETTLEMENT_ACCOUNT_CODE[payload.settlement];
  return [
    { accountId: accounts.get(debitCode)!, debit: payload.amount, credit: ZERO },
    { accountId: accounts.get(creditCode)!, debit: ZERO, credit: payload.amount },
  ];
}

registerPostingRule("automotive.vehicle_cost", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as VehicleCostPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const debitCode =
    payload.posting === "capitalized"
      ? WELL_KNOWN_CODES.vehicleInventory
      : WELL_KNOWN_CODES.vehicleReconditioningExpense;
  const creditCode = SETTLEMENT_ACCOUNT_CODE[payload.settlement];
  const accounts = await accountIdsByCode(client, event.businessId, [debitCode, creditCode]);

  return {
    lines: vehicleCostLines(accounts, payload),
    memo:
      payload.posting === "capitalized"
        ? `هزینه سرمایه‌ای خودرو${payload.stockNumber ? ` — ${payload.stockNumber}` : ""}`
        : `هزینه دوره‌ای خودرو${payload.stockNumber ? ` — ${payload.stockNumber}` : ""}`,
    postingKind: payload.posting === "capitalized" ? "automotive_cost_capitalized" : "automotive_cost_period",
  };
});

interface VehicleCostVoidPayload {
  serialId: string;
  costId: string;
  stockNumber: string;
  /**
   * The *original* entry's lines, read back from `journal_lines` by the voiding
   * service. Mirroring what was actually posted — rather than re-deriving what
   * "should" have been posted from the cost row — is the whole point of a
   * reversal: if the original chose a different settlement account, the
   * reversal has to undo *that* entry, not a hypothetical twin of it.
   */
  lines: { accountId: string; debit: string; credit: string }[];
}

/** The mirror entry that takes a voided cost back out of the books. */
registerPostingRule("automotive.vehicle_cost_void", async (event): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as VehicleCostVoidPayload;
  const lines = (payload.lines ?? []).filter(
    (line) => rialBigInt(rialText(line.debit)) !== 0n || rialBigInt(rialText(line.credit)) !== 0n,
  );
  if (lines.length === 0) return null;

  return {
    lines: lines.map((line) => ({
      accountId: line.accountId,
      debit: rialText(line.credit),
      credit: rialText(line.debit),
    })),
    memo: `ابطال هزینه خودرو${payload.stockNumber ? ` — ${payload.stockNumber}` : ""}`,
    postingKind: "automotive_cost_void",
  };
});

interface DepositPayload {
  reservationId: string;
  serialId: string;
  amount: RialText;
  method: keyof typeof VEHICLE_DEPOSIT_ACCOUNT_BY_METHOD;
}

registerPostingRule("automotive.deposit_received", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as DepositPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const moneyCode = VEHICLE_DEPOSIT_ACCOUNT_BY_METHOD[payload.method] ?? WELL_KNOWN_CODES.cash;
  const accounts = await accountIdsByCode(client, event.businessId, [
    moneyCode,
    WELL_KNOWN_CODES.layawayDeposit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(moneyCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.layawayDeposit)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "دریافت ودیعه رزرو خودرو",
    postingKind: "automotive_deposit_received",
  };
});

registerPostingRule("automotive.deposit_refunded", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as DepositPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const moneyCode = VEHICLE_DEPOSIT_ACCOUNT_BY_METHOD[payload.method] ?? WELL_KNOWN_CODES.cash;
  const accounts = await accountIdsByCode(client, event.businessId, [
    moneyCode,
    WELL_KNOWN_CODES.layawayDeposit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.layawayDeposit)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(moneyCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "بازگشت ودیعه رزرو خودرو",
    postingKind: "automotive_deposit_refunded",
  };
});

interface VehicleSaleRevenuePayload {
  serialId: string;
  orderId: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
  /** The reservation deposit applied against this invoice — it clears 2430 instead of bringing new money. */
  depositApplied?: RialText;
}

registerPostingRule("automotive.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as VehicleSaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);
  const depositApplied = payload.depositApplied ?? ZERO;
  if (rialBigInt(depositApplied) !== 0n) {
    debits.push({ code: WELL_KNOWN_CODES.layawayDeposit, amount: depositApplied });
  }

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.vehicleSalesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: ZERO })),
      {
        accountId: accounts.get(WELL_KNOWN_CODES.vehicleSalesRevenue)!,
        debit: ZERO,
        credit: payload.net,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "فروش خودرو",
    postingKind: "automotive_sale_revenue",
  };
});

interface VehicleSaleCogsPayload {
  serialId: string;
  /** The car's effective cost as it stood at the instant of sale — never recomputed later. */
  effectiveCost: RialText;
}

registerPostingRule("automotive.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as VehicleSaleCogsPayload;
  // A car sold with no recorded cost basis books no COGS (the event is still
  // recorded) — the absence of a number is not a zero-cost car.
  if (rialBigInt(payload.effectiveCost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.vehicleCogs,
    WELL_KNOWN_CODES.vehicleInventory,
  ]);

  return {
    lines: [
      {
        accountId: accounts.get(WELL_KNOWN_CODES.vehicleCogs)!,
        debit: payload.effectiveCost,
        credit: ZERO,
      },
      {
        accountId: accounts.get(WELL_KNOWN_CODES.vehicleInventory)!,
        debit: ZERO,
        credit: payload.effectiveCost,
      },
    ],
    memo: "بهای تمام‌شده خودروی فروخته‌شده",
    postingKind: "automotive_sale_cogs",
  };
});
