/**
 * Pre-built F&B chart of accounts template (Persian).
 * The wizard offers this as the default; the user can edit/add/remove rows
 * before the accounts are created. Codes follow the common 4-digit convention:
 * 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx expenses.
 */

import type { Industry } from "./industries";

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  /** code of the parent account, if any */
  parentCode?: string;
  /** A contra/reducing account (moves opposite its type's normal balance) — e.g. sales returns, an NRV allowance. */
  isContra?: boolean;
}

/**
 * The standard Iranian-accounting four-tier chart-of-accounts hierarchy:
 * گروه (group) → کل (kol) → معین (moein) → تفصیلی (tafsili). Derived from an
 * account's position in the parent_id chain, never chosen directly — see
 * `nextAccountLevel`.
 */
export type AccountLevel = "group" | "kol" | "moein" | "tafsili";

export const ACCOUNT_LEVELS: AccountLevel[] = ["group", "kol", "moein", "tafsili"];

export const ACCOUNT_LEVEL_LABELS: Record<AccountLevel, string> = {
  group: "گروه",
  kol: "کل",
  moein: "معین",
  tafsili: "تفصیلی",
};

/**
 * The level one step more detailed than `parentLevel` (group → kol → moein →
 * tafsili), or `null` if `parentLevel` is already the deepest tier — a
 * تفصیلی account can't have children. A `null` parent (no parent at all) is
 * always `group`.
 */
export function nextAccountLevel(parentLevel: AccountLevel | null): AccountLevel | null {
  if (parentLevel === null) return "group";
  const idx = ACCOUNT_LEVELS.indexOf(parentLevel);
  return idx < ACCOUNT_LEVELS.length - 1 ? ACCOUNT_LEVELS[idx + 1] : null;
}

/**
 * The shape a persisted account code must have: Latin digits only, nothing
 * else. Every template code and every well-known code follows it («1100»,
 * «1200», …), and keeping it uniform is what makes ORDER BY code read the way
 * accountants expect. Callers canonicalise Persian/Arabic digits first
 * (`toLatinDigits`); this rejects whatever is left that is not a plain numeral
 * — letters, separators, whitespace inside the code.
 */
export function isValidAccountCode(code: string): boolean {
  return /^\d+$/.test(code);
}

export type NormalBalance = "debit" | "credit";

/** Asset/expense accounts carry a debit normal balance; liability/equity/revenue carry credit. */
export function normalBalanceForType(type: AccountType): NormalBalance {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

/**
 * Accounts other parts of the system rely on (opening balances, Phase 7
 * auto-posting). Revenue isn't split by menu category here (no
 * category → account mapping exists in the schema — see Phase 7 doc), so
 * every order posts to one general `salesRevenue` account; 4100/4200 stay
 * available for manual/future per-category use.
 */
export const WELL_KNOWN_CODES = {
  cash: "1100",
  // The business's own bank account. Well-known since Phase 30: a cheque clears
  // *into the bank*, not into `bankClearing` — that one means "card money on its
  // way from the PSP" and posting a cheque there would misname it. Adding it
  // here is also what stops it being archived out from under that posting.
  bank: "1110",
  bankClearing: "1120",
  accountsReceivable: "1200",
  // Audit F11 — salary advances (مساعده) paid to staff, recovered by a later
  // payroll run. An asset until recovered (migration 0214).
  staffAdvances: "1260",
  supplierReceivable: "1210",
  vatReceivable: "1220",
  // Issue #160 §4 — the last of Wave 4's three deferrals. What SnapFood owes
  // the business after taking its commission (money hasn't arrived yet —
  // SnapFood settles on its own schedule). See migrations/0060.
  platformReceivable: "1230",
  inventory: "1300",
  // Phase 29 — in-house production. A wash account: a production run debits it
  // with the materials it issued and the conversion cost it absorbed, then
  // credits the whole lot straight back out as finished goods, so it is zero
  // the moment the run's transaction commits. It exists so the transformation
  // is legible in the ledger rather than being one inventory→inventory entry
  // that says nothing about what happened.
  workInProgress: "1310",
  inventoryInTransit: "1350",
  nrvAllowance: "1390",
  accountsPayable: "2100",
  vatPayable: "2200",
  salariesPayable: "2300",
  // Audit F11 — gross-to-net payroll (migration 0214). The withholdings a run
  // credits beside net salary payable: insurance (employee + employer +
  // unemployment shares, all owed to the same insurer), income tax withheld,
  // and any other fixed deduction the business withholds for a third party.
  // 2460/2470 were seeded by 0094 as headings for manual entries; a run posts
  // to them automatically now, which is why they are well-known (never
  // archived from under the posting).
  insurancePayable: "2460",
  payrollTaxPayable: "2470",
  otherPayrollDeductionsPayable: "2490",
  // Tip capture (issue #160 §4) — a pass-through liability owed to staff,
  // not revenue. See migrations/0059_tip_capture.sql for the product
  // decisions this rests on.
  tipsPayable: "2400",
  // Phase 27 Wave 5 — store credit is a real liability (owed to a customer),
  // posted through the domain-event engine; a customer's credit balance is
  // reconstructed from the ledger, never a mutable column.
  storeCreditPayable: "2410",
  // Phase 27 Wave 6 — gift cards are a liability too: issuing one credits it,
  // redeeming it debits it; the card's value is never a balance column.
  giftCardPayable: "2420",
  // Phase 27 Wave 9 — jewelry: the customer-deposit liability (layaway and
  // custom orders) and the gold-account (حساب طلایی) liability.
  layawayDeposit: "2430",
  goldCustomerAccount: "2450",
  openingEquity: "3900",
  historicalInventoryReconciliationEquity: "3950",
  retainedEarnings: "3800",
  salesRevenue: "4300",
  // Phase 22 Wave 4 — revenue split by sales channel. Order payment posts to
  // one of these three instead of the flat salesRevenue above, keyed off
  // orders.type (dine_in/takeaway/delivery — no new schema needed, that
  // column has existed since Phase 0). salesRevenue itself stays in the
  // template for historical entries and manual/other use, but no longer
  // receives new auto-postings.
  dineInRevenue: "4310",
  takeawayRevenue: "4320",
  deliveryRevenue: "4330",
  salesReturns: "4400",
  cogs: "5100",
  // سیستم ادواری — the periodic system's «خرید طی دوره» account (migration
  // 0144). A business whose setup chose `system: "periodic"` debits every
  // received purchase here instead of 1300; the period-close entry credits
  // it back to zero and moves B + P − E into COGS. Perpetual businesses
  // never post to it, but it is seeded on every chart so the posting rule
  // stays a rule and not a per-system template lookup.
  periodicPurchases: "5105",
  wasteExpense: "5150",
  salariesExpense: "5200",
  // Audit F11 — the employer's insurance (and unemployment) share is a cost
  // on top of gross pay, not part of it (migration 0214).
  employerInsuranceExpense: "5220",
  // Phase 27 Wave 7 — sales-staff commission, posted as a payroll liability
  // (Debit this, Credit salariesPayable) through the domain-event engine.
  commissionExpense: "5210",
  inventoryCountExpense: "5160",
  // The retail trades' count shortage. Deliberately NOT 5160: cosmetics
  // already spends that code on «کالای منقضی و تستر» (an identified loss —
  // expiry and testers), and unexplained shrinkage found at a count is a
  // different fact that must not be folded into it. One code across all four
  // retail trades rather than 5160-for-three-and-5190-for-one, so the posting
  // rule stays a rule and not a per-industry lookup.
  retailCountShortageExpense: "5190",
  inventoryWriteDownExpense: "5170",
  // Phase 29 — labour/overhead a production run capitalises into the cost of
  // what it made. A CONTRA-expense, and that is the whole point: the baker's
  // wage is already an expense (5200) and the oven's gas already an expense
  // (5400), so absorbing that effort into the cake's cost must not book it a
  // second time. Absorbing CREDITS this account, which nets against those in
  // the P&L; the cost then re-emerges as COGS when the cake is sold, which is
  // the period it belongs to. Deliberately *not* in any industry's cost-of-sales
  // list below — it offsets the overhead it capitalised, so it belongs beside that
  // overhead, not inside gross profit (where it would overstate margin in the
  // baking period and understate it at sale).
  appliedConversionCost: "5180",
  inventoryCountGain: "4910",
  // Phase 42 — warehouse documents (رسید/حواله انبار). Every industry's COA
  // template seeds «سایر درآمدها» (4900) and «سایر هزینه‌ها» (5900), so the
  // generic in/out document posts against them without a per-industry lookup:
  // a receipt is stock received without an invoice (other income), an issue
  // is stock sent out without a sale (other expense).
  otherIncome: "4900",
  otherExpense: "5900",
  // Phase 22 Wave 4 — cost of using a third-party online-ordering platform
  // (e.g. a delivery marketplace's cut of the sale). Settled via the manual-
  // journal workflow, the same "new well-known account, not deep posting-path
  // integration" pattern Phase 16 used for input VAT — there's no "platform"
  // order-source concept in the schema yet to auto-post against.
  platformCommissionExpense: "5650",
  // Phase 22 Wave 5 — fixed-asset depreciation. accumulatedDepreciation is a
  // contra-asset (see coa-template.ts's isContra flag below), reducing the
  // fixed-asset line it's parented under.
  accumulatedDepreciation: "1510",
  depreciationExpense: "5700",
  // Phase 21 Wave 3 — jewelry (JEWELRY_COA_TEMPLATE below), not seeded for
  // an F&B business. goldSalesRevenue and makingChargeRevenue are kept as
  // two separate accounts (not folded into one "gold sales" line) because
  // they need to be reported separately for VAT: metal value is VAT-exempt
  // in Iranian tax practice, making charge + profit is not (see
  // src/lib/gold-pricing.ts).
  goldInventory: "1320",
  goldSalesRevenue: "4500",
  makingChargeRevenue: "4600",
  goldCogs: "5110",
  // Phase 21 Wave 4 — consignment (امانی). A consigned sale never touches
  // goldInventory/goldCogs (the shop never owned the piece) or
  // goldSalesRevenue/makingChargeRevenue (that money isn't the shop's
  // revenue, it's owed to the consignor) — it posts to these two instead.
  consignmentPayable: "2110",
  consignmentCommissionRevenue: "4700",
  // Phase 21 Wave 5 — watch (WATCH_COA_TEMPLATE below). A watch sale is an
  // ordinary finished-goods sale (no VAT-exempt component the way gold's
  // metal value is), so it needs only the usual inventory/revenue/COGS
  // triple. Repairs are the industry's second revenue stream and are kept
  // separate from unit sales — a shop wants to know what it earns servicing
  // watches vs. selling them, and the parts it consumes are a cost of that
  // service, not of a sale.
  watchInventory: "1330",
  watchSalesRevenue: "4550",
  watchCogs: "5120",
  repairServiceRevenue: "4800",
  repairPartsExpense: "5130",
  // Phase 21 Wave 6 — accessories (بدلیجات, ACCESSORIES_COA_TEMPLATE
  // below). Same three-account shape as watch: variant stock is ordinary
  // finished goods bought and resold, with no industry-specific split.
  accessoryInventory: "1340",
  accessorySalesRevenue: "4560",
  accessoryCogs: "5140",
  // Phase 27 Wave 1 — cosmetics & toiletries (COSMETICS_COA_TEMPLATE below).
  // Same three-account finished-goods shape as watch/accessories, plus a
  // fourth account for the two non-COGS ways cosmetics stock leaves the shelf
  // (expired write-offs in Wave 2, tester/sample stock in Wave 3).
  cosmeticInventory: "1350",
  cosmeticSalesRevenue: "4570",
  cosmeticCogs: "5150",
  cosmeticExpiredAndTester: "5160",
  // Phase 38 — wholesale (عمده‌فروشی). Same finished-goods shape as
  // accessories, but with its own accounts so a wholesale business reports
  // its inventory and gross margin separately from a retail counter.
  wholesaleInventory: "1371",
  wholesaleSalesRevenue: "4581",
  wholesaleCogs: "5181",
  // Phase 38 — tools & fittings (ابزار و یراق‌آلات). A tools/hardware shop
  // stocks countable items (tools, locks, hinges, fittings), so it is the
  // same finished-goods triple with its own accounts.
  toolsInventory: "1372",
  toolsSalesRevenue: "4582",
  toolsCogs: "5182",
  // Phase 38 — haberdashery (خرازی). Sewing notions are sold in units and,
  // for threads/ribbons, in fractional quantities; `item_stock` is numeric
  // so both work, and these are the trade's own finished-goods accounts.
  haberdasheryInventory: "1373",
  haberdasherySalesRevenue: "4583",
  haberdasheryCogs: "5183",
  // Phase 27 Wave 8 — the retail trades' in-transit account for inter-branch
  // transfers. F&B's 1350 (inventoryInTransit) is the same code cosmetics
  // uses for its *own* inventory, so the retail trades get their own 1360
  // rather than sharing a code that would make a cosmetics transfer post to
  // itself and zero out.
  retailInventoryInTransit: "1360",
  // Phase 30 — cheques. اسناد دریافتنی/پرداختنی, one معین per place a cheque can
  // be, because "where is that cheque right now" is the question the register
  // exists to answer and a single balance cannot.
  //
  // There is deliberately no «چک‌های واگذارشده» account: an endorsed cheque is
  // contingent, not an asset the shop still holds, and carrying it would need an
  // unbalanced memo pair. Endorsement posts Debit accountsPayable / Credit
  // chequesOnHand and the contingency lives as a *status* on the `cheques` row,
  // so a later bounce is a real entry (Debit chequesReturned / Credit
  // accountsPayable) rather than the unwinding of a memo. See
  // docs/phases/Phase-30-Cheque-Management.md.
  chequesReceivable: "1240",
  chequesOnHand: "1241",
  chequesInCollection: "1242",
  chequesReturned: "1244",
  chequesPayable: "2120",
  chequesIssued: "2121",
  chequesIssuedReturned: "2122",
  bouncedChequeExpense: "5860",
  // Phase 37 Wave 4 — every trade can run a marketing campaign (a cross-industry
  // feature), so the marketing/advertising expense heading is core to every
  // chart. 5600 has been on every template since long before this phase; this
  // well-known name just makes the messaging posting rule refer to one code.
  marketingExpense: "5600",
  // The credit side of the message-cost document: what the business owes the
  // platform for message credits actually consumed. A liability every trade
  // carries, because metered messaging is cross-industry.
  platformMessageCreditPayable: "2455",
  // Issue #799 — AEC (مهندسی عمران، معماری و پیمانکاری). The trade does not
  // sell goods, so it has no single «فروش» account: an engineering office's
  // income, a supervision contract's fee and a contractor's progress billing
  // are three different revenues an owner reads separately, exactly the way
  // F&B splits its channels and jewellery splits metal from اجرت. 4610 is the
  // *default* account a statement posts to (see accounting-posting-rules.ts);
  // the other two exist so the split is available from day one rather than
  // being a later migration.
  aecDesignRevenue: "4610",
  aecSupervisionRevenue: "4620",
  aecConstructionRevenue: "4630",
  // Retention (حسن انجام کار): a client withholds a percentage of every
  // certificate until the defects-liability period ends. It is the AEC
  // business's single most-asked "where is my money" question, so it gets its
  // own receivable per project rather than hiding in 1200 — and its payable
  // twin, because a contractor withholds the same from its subcontractors.
  aecRetentionReceivable: "1250",
  aecRetentionPayable: "2440",
  // Work performed on uncompleted contracts, carried as an asset until the
  // contract is billed. Wave 8's progress certificates are what will post
  // here; the account is seeded now so the chart a business is *given* is the
  // chart its trade actually uses.
  aecContractWorkInProgress: "1380",
  // Subcontractors and consultants are settled separately from material
  // suppliers: an engineer reconciling a site wants "what do we owe the
  // pیمانکاران" apart from "what do we owe the merchants".
  aecSubcontractorPayable: "2130",
  // Cost of sales for a contractor is direct project cost. The three accounts
  // split it the way a project manager does — what was built with, what was
  // subcontracted, what was hired — while `costOfSalesCodesForIndustry` lists
  // them together so gross profit stays a project margin and not an
  // accounting artefact.
  aecProjectDirectCost: "5191",
  aecSubcontractorExpense: "5192",
  aecEquipmentExpense: "5193",
  // Issue #839 — automotive (خودرو و نمایشگاه اتومبیل). A car is finished goods
  // bought and resold, so the trade needs the usual inventory/revenue/COGS
  // triple and nothing exotic — but three of its codes are genuinely its own:
  //
  //   * 1375 is the *landed-cost clearing* account. Freight, customs, the
  //     pre-delivery inspection and reconditioning are paid before or while a
  //     vehicle is brought in, and the model's explicit decision (see
  //     `automotive-vehicle-costs.ts` / the domain service) is: costs marked
  //     `capitalized` debit the vehicle's own inventory; costs marked
  //     `period_expense` debit 5195. 1375 exists so a transport/customs bill
  //     that arrives before its vehicle can be parked somewhere honest rather
  //     than guessed at.
  //   * 5194/5195 split cost of sales from period reconditioning, which is the
  //     "do not silently mix both models" decision §5 of the issue demands.
  //   * 2465 is the trade-in obligation: what the dealership owes the customer
  //     for the car it accepted, until it is cleared against the sale invoice
  //     or paid out. Nothing posts to it in Wave 1-4; it is seeded so the
  //     second-wave trade-in flow has the account its trade actually uses.
  vehicleInventory: "1370",
  vehicleLandedCostClearing: "1375",
  vehicleSalesRevenue: "4590",
  vehicleCogs: "5194",
  vehicleReconditioningExpense: "5195",
  vehicleTradeInPayable: "2465",
} as const;

/**
 * The expense codes that are cost of sales (material cost + inventory
 * shrinkage), not overhead — the "by function" split (COGS vs. SG&A) a
 * multi-step income statement needs for gross profit. Labor
 * (`salariesExpense`) is tracked separately since COGS + labor = "prime cost",
 * the standard F&B management metric; everything else in `type='expense'` is
 * operating expense.
 *
 * Keyed by industry, because a flat list is silently wrong for four of the five
 * trades: it named only F&B's codes, so a jeweller's 5110, a watch shop's 5120
 * and an accessories shop's 5140 fell into operating expense and their
 * `grossProfit` came out equal to total revenue. Cosmetics happened to work,
 * and only because its COGS is 5150 — the code F&B uses for waste.
 *
 * `appliedConversionCost` (5180) stays out of every list on purpose: it offsets
 * the overhead a production run capitalised, so it belongs beside that overhead
 * rather than inside gross profit. See its note in WELL_KNOWN_CODES.
 */
// 5105 (خرید طی دوره) is cost of sales for every industry: in the periodic
// system its balance between closes IS the period's yet-unclosed cost of
// goods, and each close credits it back to zero — so counting it keeps the
// gross-profit line honest mid-period and changes nothing once a period is
// closed. Perpetual businesses never post to it.
const COST_OF_SALES_CODES_BY_INDUSTRY: Record<Industry, readonly string[]> = {
  service_saas: [
    WELL_KNOWN_CODES.cogs,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
  ],
  // Issue #799 — a contractor's cost of sales is *direct project cost*, not
  // goods bought for resale. The three accounts are its material/execution,
  // subcontracting and plant-hire sides; listing them together is what keeps
  // gross profit meaning "project margin" instead of collapsing every project
  // cost into overhead.
  architecture_construction: [
    WELL_KNOWN_CODES.aecProjectDirectCost,
    WELL_KNOWN_CODES.aecSubcontractorExpense,
    WELL_KNOWN_CODES.aecEquipmentExpense,
    WELL_KNOWN_CODES.periodicPurchases,
  ],
  food_service: [
    WELL_KNOWN_CODES.cogs,
    WELL_KNOWN_CODES.wasteExpense,
    WELL_KNOWN_CODES.inventoryCountExpense,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
  ],
  // Issue #839 — a dealership's cost of sales is the vehicle it delivered at
  // its frozen effective cost, plus the write-down of a unit that will not
  // sell. Reconditioning that was *capitalized* never appears here (it is
  // already inside the unit's cost); only reconditioning deliberately posted
  // as a period expense does — and that one is deliberately NOT in this list,
  // because it is overhead by the business's own decision, exactly as
  // `appliedConversionCost` is for F&B.
  automotive: [
    WELL_KNOWN_CODES.vehicleCogs,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  jewelry: [
    WELL_KNOWN_CODES.goldCogs,
    WELL_KNOWN_CODES.repairPartsExpense,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  watch: [
    WELL_KNOWN_CODES.watchCogs,
    WELL_KNOWN_CODES.repairPartsExpense,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  accessories: [
    WELL_KNOWN_CODES.accessoryCogs,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  cosmetics: [
    WELL_KNOWN_CODES.cosmeticCogs,
    WELL_KNOWN_CODES.cosmeticExpiredAndTester,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  wholesale: [
    WELL_KNOWN_CODES.wholesaleCogs,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  tools_fittings: [
    WELL_KNOWN_CODES.toolsCogs,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  haberdashery: [
    WELL_KNOWN_CODES.haberdasheryCogs,
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    WELL_KNOWN_CODES.periodicPurchases,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
};

export function costOfSalesCodesForIndustry(industry: Industry): readonly string[] {
  return COST_OF_SALES_CODES_BY_INDUSTRY[industry];
}

/**
 * Whether an account code is non-current, for the balance sheet's
 * جاری/غیرجاری split. Decided by code range rather than by a flag on the
 * account, because the ranges are the convention the templates already follow
 * and a business that adds its own account under 1500/2500 means the same
 * thing by it:
 *
 *   * assets 1500–1599 — اثاثه و تجهیزات and its accumulated depreciation;
 *   * liabilities 2500 and up — تسهیلات و وام پرداختنی.
 *
 * Everything else is current. Equity is neither, and asking about it is a
 * caller's mistake rather than a third answer, so it returns false.
 */
export function isNonCurrentCode(type: AccountType, code: string): boolean {
  const numeric = Number.parseInt(code, 10);
  if (!Number.isFinite(numeric)) return false;
  if (type === "asset") return numeric >= 1500 && numeric <= 1599;
  if (type === "liability") return numeric >= 2500;
  return false;
}

/**
 * Headings every trade needs, whatever it sells — spread into all five
 * templates rather than copied into each, so "every business gets these" is
 * true by construction. The four retail templates drifting from F&B's is
 * exactly what left a jeweller unable to run payroll (no 5200 to debit) or
 * monthly depreciation (no 1510/5700) at all, while the pages offering both
 * are core to every industry (`industry-profile.ts`'s CORE_MODULES).
 */
const SHARED_ASSET_ACCOUNTS: TemplateAccount[] = [
  { code: "1130", name: "تنخواه", type: "asset", parentCode: "1000" },
  // Cheques received. One کل with a معین per place the cheque can be: still in
  // the drawer, handed to the bank for collection, or dishonoured. An endorsed
  // cheque has no account here on purpose — see the `chequesOnHand` note in
  // WELL_KNOWN_CODES.
  { code: "1240", name: "اسناد دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1241", name: "چک‌های نزد صندوق", type: "asset", parentCode: "1240" },
  { code: "1242", name: "چک‌های در جریان وصول", type: "asset", parentCode: "1240" },
  { code: "1244", name: "چک‌های برگشتی", type: "asset", parentCode: "1240" },
  // Salary advances, recovered by the next payroll run (audit F11, 0214).
  { code: "1260", name: "مساعده و علی‌الحساب کارکنان", type: "asset", parentCode: "1000" },
];

const SHARED_LIABILITY_ACCOUNTS: TemplateAccount[] = [
  // Cheques we wrote: outstanding until presented, and a place for one of ours
  // that bounced.
  { code: "2120", name: "اسناد پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2121", name: "چک‌های صادرشده در جریان", type: "liability", parentCode: "2120" },
  { code: "2122", name: "چک‌های پرداختنی برگشتی", type: "liability", parentCode: "2120" },
  { code: "2430", name: "پیش‌دریافت از مشتری", type: "liability", parentCode: "2000" },
  // Payroll withholdings. A gross-to-net run (audit F11) credits 2460/2470
  // with the insurance and income tax it withheld and 2490 with any other
  // fixed deduction; only net pay goes to 2300.
  { code: "2460", name: "بیمه پرداختنی", type: "liability", parentCode: "2300" },
  { code: "2470", name: "مالیات حقوق پرداختنی", type: "liability", parentCode: "2300" },
  { code: "2490", name: "سایر کسور حقوق پرداختنی", type: "liability", parentCode: "2300" },
  { code: "2480", name: "مالیات بر درآمد (عملکرد) پرداختنی", type: "liability", parentCode: "2000" },
  // Phase 37 Wave 4 — what the business owes the platform for message credits
  // actually consumed. Metered messaging is cross-industry, so the heading is
  // shared rather than F&B-only (the same reason 5600 marketing expense is on
  // every chart).
  { code: "2455", name: "پرداختنی به پلتفرم (اعتبار پیام)", type: "liability", parentCode: "2000" },
  // Non-current, and the reason `isNonCurrentCode` treats 2500+ as such.
  { code: "2500", name: "تسهیلات و وام پرداختنی", type: "liability", parentCode: "2000" },
];

const SHARED_EQUITY_ACCOUNTS: TemplateAccount[] = [
  { code: "3200", name: "برداشت مالک", type: "equity", parentCode: "3000", isContra: true },
];

const SHARED_REVENUE_ACCOUNTS: TemplateAccount[] = [
  // Contra-revenue. Order payment credits revenue *net* of the discount
  // (postExactOrderPaymentEntry), so nothing posts here yet — it exists so a
  // business recording a discount by hand has somewhere honest to put it.
  { code: "4350", name: "تخفیفات فروش", type: "revenue", parentCode: "4000", isContra: true },
  { code: "4920", name: "سود فروش دارایی ثابت", type: "revenue", parentCode: "4000" },
];

const SHARED_EXPENSE_ACCOUNTS: TemplateAccount[] = [
  // Periodic-system purchases (سیستم ادواری) — see WELL_KNOWN_CODES.periodicPurchases.
  { code: "5105", name: "خرید طی دوره (سیستم ادواری)", type: "expense", parentCode: "5000" },
  // The employer's insurance and unemployment shares (audit F11, 0214).
  { code: "5220", name: "بیمه سهم کارفرما", type: "expense", parentCode: "5000" },
  { code: "5750", name: "زیان فروش دارایی ثابت", type: "expense", parentCode: "5000" },
  { code: "5800", name: "کارمزد بانکی و درگاه پرداخت", type: "expense", parentCode: "5000" },
  { code: "5810", name: "کسری و اضافه صندوق", type: "expense", parentCode: "5000" },
  { code: "5850", name: "هزینه مالی (سود تسهیلات)", type: "expense", parentCode: "5000" },
  { code: "5860", name: "هزینه چک برگشتی و جرایم بانکی", type: "expense", parentCode: "5000" },
  { code: "5950", name: "هزینه مالیات بر درآمد", type: "expense", parentCode: "5000" },
];

/**
 * The generic accounts the four retail templates were missing. F&B has carried
 * all six since Phase 22; the retail charts were written as "generic accounts
 * plus this trade's inventory/revenue/COGS triple" and never picked them up,
 * which is what made payroll, depreciation and a markdown fail with
 * `ledger_account_missing` in a jewellery, watch, accessories or cosmetics shop.
 */
const RETAIL_ASSET_ACCOUNTS: TemplateAccount[] = [
  { code: "1210", name: "دریافتنی از تأمین‌کننده", type: "asset", parentCode: "1000" },
  { code: "1510", name: "استهلاک انباشته", type: "asset", parentCode: "1500", isContra: true },
];

/**
 * Revenue accounts every retail chart needs but none of the four listed. 4910
 * is the same code and the same name F&B has carried since Phase 22 — a count
 * surplus means one thing whatever the shop sells.
 */
const RETAIL_REVENUE_ACCOUNTS: TemplateAccount[] = [
  { code: "4910", name: "درآمد اضافه شمارش موجودی", type: "revenue", parentCode: "4000" },
];

const RETAIL_EXPENSE_ACCOUNTS: TemplateAccount[] = [
  { code: "5170", name: "هزینه کاهش ارزش موجودی", type: "expense", parentCode: "5000" },
  { code: "5190", name: "هزینه کسری انبارگردانی", type: "expense", parentCode: "5000" },
  { code: "5200", name: "حقوق و دستمزد", type: "expense", parentCode: "5000" },
  { code: "5500", name: "ملزومات مصرفی", type: "expense", parentCode: "5000" },
  { code: "5700", name: "هزینه استهلاک", type: "expense", parentCode: "5000" },
];

export const FNB_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1210", name: "دریافتنی از تأمین‌کننده", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1230", name: "مطالبات از پلتفرم‌های سفارش آنلاین", type: "asset", parentCode: "1000" },
  { code: "1300", name: "موجودی مواد و کالا", type: "asset", parentCode: "1000" },
  { code: "1310", name: "کالای در جریان ساخت", type: "asset", parentCode: "1000" },
  { code: "1350", name: "موجودی در راه", type: "asset", parentCode: "1000" },
  { code: "1390", name: "ذخیره کاهش ارزش موجودی", type: "asset", parentCode: "1000", isContra: true },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },
  { code: "1510", name: "استهلاک انباشته", type: "asset", parentCode: "1500", isContra: true },

  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2400", name: "انعام پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },
  { code: "3950", name: "حقوق تطبیق تاریخی موجودی", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4100", name: "فروش غذا", type: "revenue", parentCode: "4000" },
  { code: "4200", name: "فروش نوشیدنی", type: "revenue", parentCode: "4000" },
  { code: "4300", name: "فروش (عمومی)", type: "revenue", parentCode: "4000" },
  { code: "4310", name: "فروش حضوری (سالن)", type: "revenue", parentCode: "4000" },
  { code: "4320", name: "فروش بیرون‌بر", type: "revenue", parentCode: "4000" },
  { code: "4330", name: "فروش ارسالی", type: "revenue", parentCode: "4000" },
  { code: "4360", name: "درآمد حق سرویس", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4910", name: "درآمد اضافه شمارش موجودی", type: "revenue", parentCode: "4000" },

  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5100", name: "بهای تمام‌شده مواد", type: "expense", parentCode: "5000" },
  { code: "5150", name: "ضایعات مواد", type: "expense", parentCode: "5000" },
  { code: "5160", name: "هزینه کسری و مغایرت شمارش", type: "expense", parentCode: "5000" },
  { code: "5170", name: "هزینه کاهش ارزش موجودی", type: "expense", parentCode: "5000" },
  { code: "5180", name: "هزینهٔ تبدیل جذب‌شده در تولید", type: "expense", parentCode: "5000", isContra: true },
  { code: "5200", name: "حقوق و دستمزد", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5500", name: "ملزومات مصرفی", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5650", name: "کارمزد پلتفرم‌های سفارش آنلاین", type: "expense", parentCode: "5000" },
  { code: "5700", name: "هزینه استهلاک", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 21 Wave 3 — jewelry (طلا و جواهر) chart of accounts. Not yet seeded
 * by any wizard branch (jewelry isn't a selectable industry in `/welcome`
 * yet — see `ENABLED_INDUSTRIES`, `src/lib/industries.ts`); this exists so
 * the gold-sale posting rules (`src/lib/gold-posting-rules.ts`) and their
 * tests have real accounts to post against ahead of that wizard work.
 * Mirrors FNB_COA_TEMPLATE's structure, reusing every generic account
 * (cash, bank, AR, AP, VAT payable/receivable) and swapping the
 * inventory/revenue/COGS accounts for jewelry-appropriate ones.
 */
export const JEWELRY_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1320", name: "موجودی طلا و جواهر", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2110", name: "پرداختنی به امانت‌گذاران", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },
  { code: "2450", name: "حساب طلایی مشتریان", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4500", name: "فروش طلا (ارزش فلز)", type: "revenue", parentCode: "4000" },
  { code: "4600", name: "درآمد اجرت و سود", type: "revenue", parentCode: "4000" },
  { code: "4700", name: "درآمد کارمزد فروش امانی", type: "revenue", parentCode: "4000" },
  { code: "4800", name: "درآمد تعمیرات", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5110", name: "بهای تمام‌شده طلای فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5130", name: "بهای قطعات مصرفی تعمیرات", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 21 Wave 5 — watch (ساعت) chart of accounts. Mirrors
 * JEWELRY_COA_TEMPLATE's approach: every generic account (cash, bank, AR,
 * AP, VAT) is reused unchanged, and only the industry's own
 * inventory/revenue/COGS accounts differ — plus the two repair accounts, a
 * watch shop's second line of business (see WELL_KNOWN_CODES above).
 */
export const WATCH_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1330", name: "موجودی ساعت و قطعات", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4550", name: "فروش ساعت", type: "revenue", parentCode: "4000" },
  { code: "4800", name: "درآمد تعمیرات", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5120", name: "بهای تمام‌شده ساعت فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5130", name: "بهای قطعات مصرفی تعمیرات", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 21 Wave 6 — accessories (بدلیجات) chart of accounts. The thinnest
 * of the four: accessories are ordinary finished goods bought and resold in
 * variant matrices, with no weight, no serial identity, and no service
 * line — so this is the generic template plus one inventory/revenue/COGS
 * triple of its own.
 */
export const ACCESSORIES_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1340", name: "موجودی بدلیجات", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4560", name: "فروش بدلیجات", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5140", name: "بهای تمام‌شده بدلیجات فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 27 Wave 1 — cosmetics & toiletries (آرایشی و بهداشتی) chart of
 * accounts. Mirrors ACCESSORIES_COA_TEMPLATE's structure — every generic
 * account (cash, bank, AR, AP, VAT) is reused unchanged — and swaps the
 * inventory/revenue/COGS triple for the cosmetics one, plus 5160 (کالای
 * منقضی و تستر), the expense account Waves 2 and 3 post expiry write-offs
 * and tester/sample consumption to.
 */
export const COSMETICS_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1350", name: "موجودی کالای آرایشی و بهداشتی", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4570", name: "فروش لوازم آرایشی و بهداشتی", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5150", name: "بهای تمام‌شده کالای آرایشی و بهداشتی فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5160", name: "کالای منقضی و تستر", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 38 — wholesale (عمده‌فروشی) chart of accounts. Built from the same
 * generic retail skeleton as accessories/cosmetics: cash/bank/AR/AP, VAT,
 * payroll, fixed assets, cheques, inventory count variance — and the trade's
 * own inventory/revenue/COGS triple. A wholesale business also uses the shared
 * «تخفیفات فروش» (4350) and «برگشت از فروش» (4400) accounts, which is where
 * bulk/trade discounts and wholesale returns land.
 */
export const WHOLESALE_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1371", name: "موجودی کالای عمده‌فروشی", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4581", name: "فروش عمده", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5181", name: "بهای تمام‌شده کالای فروخته‌شده عمده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 38 — tools & fittings (ابزار و یراق‌آلات) chart of accounts. Same
 * generic retail skeleton as wholesale; only the inventory/revenue/COGS
 * accounts differ. The count-variance and markdown accounts are the shared
 * retail ones, so reorder/low-stock and physical counts post in this trade
 * exactly as they do in accessories.
 */
export const TOOLS_FITTINGS_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1372", name: "موجودی ابزار و یراق‌آلات", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4582", name: "فروش ابزار و یراق", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5182", name: "بهای تمام‌شده ابزار و یراق فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * Phase 38 — haberdashery (خرازی) chart of accounts. Again the generic retail
 * skeleton plus the trade's own inventory/revenue/COGS triple. Haberdashery
 * often sells fractional lengths (thread, ribbon, trim), but that is a
 * quantity convention of the `item_stock` model, not an extra account.
 */
export const HABERDASHERY_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1373", name: "موجودی لوازم خرازی", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4583", name: "فروش لوازم خرازی", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5183", name: "بهای تمام‌شده لوازم خرازی فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

export const SERVICE_SAAS_COA_TEMPLATE: TemplateAccount[] = [
  // Keep the shared Iranian accounting controls (cheques, payroll, VAT,
  // installments, assets and project materials) while removing hospitality
  // revenue channels from the service-company chart.
  ...FNB_COA_TEMPLATE.filter((account) => ![
    "4100", "4200", "4310", "4320", "4330", "4360", "5650",
  ].includes(account.code)),
  { code: "4500", name: "درآمد اشتراک و مصرف", type: "revenue", parentCode: "4000" },
  { code: "4510", name: "درآمد پیاده‌سازی و مشاوره", type: "revenue", parentCode: "4000" },
  { code: "4520", name: "درآمد طراحی و خدمات وب‌سایت", type: "revenue", parentCode: "4000" },
  { code: "5660", name: "هزینه هوش مصنوعی و پردازش", type: "expense", parentCode: "5000" },
  { code: "5670", name: "هزینه میزبانی، ذخیره‌سازی و پیام", type: "expense", parentCode: "5000" },
];

/**
 * Issue #799 — AEC (مهندسی عمران، معماری و پیمانکاری) chart of accounts.
 *
 * Built by *subtracting* from the F&B chart, exactly as `SERVICE_SAAS_COA_TEMPLATE`
 * is, and for the same two reasons: every shared Iranian accounting control
 * (cheques, payroll, VAT, penalties, fixed assets, marketing) stays present by
 * construction, while the café's own lines are removed by an explicit list
 * rather than by copying 60 rows and hoping nothing drifts. The list below is
 * therefore the "no restaurant concept leaks into this trade" rule made
 * executable — and `coa-template.test.ts` asserts it, so re-adding a
 * hospitality account to the F&B template cannot silently reappear here.
 *
 * Removed: the three food/beverage revenue channels and the service charge, the
 * channel-specific online-platform commission (an AEC business is not on
 * delivery marketplaces), the recipe/inventory machinery that only makes sense
 * for a kitchen (بهای تمام‌شده مواد، ضایعات مواد، کسری شمارش، هزینهٔ تبدیل
 * جذب‌شده، کالای در جریان ساخت). What replaces them is the trade's own
 * vocabulary: three revenues, retention on both sides, contract work in
 * progress, subcontractor payable, and direct project cost.
 *
 * There is deliberately no `pos`/`stock` module in this industry's profile
 * (industry-profile.ts), so nothing here is a "selling counter" chart: the
 * accounts exist for Accounting's own documents — a manual journal, a receipt,
 * a supplier invoice, and Wave 8's progress certificates.
 */
export const ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE: TemplateAccount[] = [
  ...FNB_COA_TEMPLATE.filter(
    (account) =>
      ![
        // Hospitality revenue channels and the service charge.
        "4100", "4200", "4310", "4320", "4330", "4360",
        // Delivery-marketplace commission: a café's channel, not a project's cost.
        "5650",
        // Kitchen inventory machinery — recipe costing, waste, count variance
        // and the production conversion account.
        "5100", "5150", "5160", "5180", "1310",
      ].includes(account.code),
  ),
  // --- the trade's own assets and liabilities -------------------------------
  { code: "1250", name: "حسن انجام کار (نگهداشت وجه‌الضمان)", type: "asset", parentCode: "1000" },
  { code: "1380", name: "کار در جریان قراردادهای پیمانکاری", type: "asset", parentCode: "1000" },
  { code: "2130", name: "حساب‌های پرداختنی پیمانکاران و مشاوران", type: "liability", parentCode: "2000" },
  { code: "2440", name: "حسن انجام کار پرداختنی", type: "liability", parentCode: "2000" },
  // --- the trade's own revenues --------------------------------------------
  { code: "4610", name: "درآمد خدمات طراحی و مهندسی", type: "revenue", parentCode: "4000" },
  { code: "4620", name: "درآمد نظارت و مشاوره", type: "revenue", parentCode: "4000" },
  { code: "4630", name: "درآمد پیمانکاری و اجرا", type: "revenue", parentCode: "4000" },
  // --- direct project cost (the trade's cost of sales) ---------------------
  { code: "5191", name: "بهای تمام‌شدهٔ پروژه‌ها (مصالح، دستمزد و اجرا)", type: "expense", parentCode: "5000" },
  { code: "5192", name: "هزینهٔ پیمانکاران جزء و مشاوران", type: "expense", parentCode: "5000" },
  { code: "5193", name: "اجاره و هزینهٔ ماشین‌آلات و تجهیزات اجرایی", type: "expense", parentCode: "5000" },
];


export const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];
/**
 * Issue #839 — automotive (خودرو و نمایشگاه اتومبیل) chart of accounts.
 *
 * The generic skeleton every retail chart reuses (cash, bank, AR, AP, VAT,
 * prepayments, fixed assets, salaries, the shared cheque/deposit/equity
 * headings) plus this trade's own five accounts: «موجودی خودرو» (1370), the
 * landed-cost clearing heading (1375), «فروش خودرو» (4590), «بهای تمام‌شده
 * خودروی فروخته‌شده» (5194) and «هزینه بازسازی و آماده‌سازی خودرو» (5195).
 *
 * 2430 «پیش‌دریافت از مشتری» is the *shared* customer-advance liability and is
 * NOT restated here: a reservation deposit is that concept, not a second one,
 * which is what §7 of the issue asks for ("reuse an existing customer
 * advance/liability concept; do not invent duplicate accounting semantics").
 */
export const AUTOMOTIVE_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1370", name: "موجودی خودرو", type: "asset", parentCode: "1000" },
  { code: "1375", name: "هزینه‌های حمل و ترخیص خودرو (واسط)", type: "asset", parentCode: "1000" },
  { code: "1360", name: "کالای در راه", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  ...RETAIL_ASSET_ACCOUNTS,
  ...SHARED_ASSET_ACCOUNTS,

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2410", name: "اعتبار فروشگاهی", type: "liability", parentCode: "2000" },
  { code: "2420", name: "کارت هدیه", type: "liability", parentCode: "2000" },
  { code: "2465", name: "تعهد بابت معاوضه خودرو", type: "liability", parentCode: "2000" },

  ...SHARED_LIABILITY_ACCOUNTS,

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  ...SHARED_EQUITY_ACCOUNTS,

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4590", name: "فروش خودرو", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },

  ...RETAIL_REVENUE_ACCOUNTS,
  ...SHARED_REVENUE_ACCOUNTS,

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5194", name: "بهای تمام‌شده خودروی فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5195", name: "هزینه بازسازی و آماده‌سازی خودرو", type: "expense", parentCode: "5000" },
  { code: "5210", name: "پورسانت فروش", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
  ...RETAIL_EXPENSE_ACCOUNTS,
  ...SHARED_EXPENSE_ACCOUNTS,
];

/**
 * The seed chart of accounts an industry starts from. One place, because
 * three call sites need the same answer: `seedChartOfAccounts`
 * (business-provisioning.ts, the platform console's path),
 * `/api/setup/accounts`'s GET (the wizard's path), and the wizard copy that
 * names the template. Two industries could get away with a ternary in each;
 * four cannot.
 */
export function coaTemplateForIndustry(industry: Industry): readonly TemplateAccount[] {
  switch (industry) {
    case "service_saas":
      return SERVICE_SAAS_COA_TEMPLATE;
    case "architecture_construction":
      return ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE;
    case "jewelry":
      return JEWELRY_COA_TEMPLATE;
    case "watch":
      return WATCH_COA_TEMPLATE;
    case "accessories":
      return ACCESSORIES_COA_TEMPLATE;
    case "cosmetics":
      return COSMETICS_COA_TEMPLATE;
    case "wholesale":
      return WHOLESALE_COA_TEMPLATE;
    case "tools_fittings":
      return TOOLS_FITTINGS_COA_TEMPLATE;
    case "haberdashery":
      return HABERDASHERY_COA_TEMPLATE;
    case "automotive":
      return AUTOMOTIVE_COA_TEMPLATE;
    case "food_service":
      return FNB_COA_TEMPLATE;
  }
}

/**
 * Validate a (possibly user-edited) account list before creation.
 * Returns error strings (Persian, shown directly in the wizard); empty = valid.
 */
export function validateAccounts(accounts: TemplateAccount[]): string[] {
  const errors: string[] = [];
  if (accounts.length === 0) {
    errors.push("حداقل یک حساب لازم است.");
    return errors;
  }
  const codes = new Set<string>();
  for (const a of accounts) {
    if (!a.code?.trim()) errors.push(`حساب «${a.name || "?"}» کد ندارد.`);
    else if (codes.has(a.code)) errors.push(`کد حساب «${a.code}» تکراری است.`);
    else codes.add(a.code);
    if (!a.name?.trim()) errors.push(`حساب با کد «${a.code}» نام ندارد.`);
    if (!ACCOUNT_TYPES.includes(a.type)) errors.push(`نوع حساب «${a.code}» نامعتبر است.`);
  }
  for (const a of accounts) {
    if (a.parentCode && !codes.has(a.parentCode)) {
      errors.push(`حساب والد «${a.parentCode}» برای «${a.code}» وجود ندارد.`);
    }
    if (a.parentCode === a.code) {
      errors.push(`حساب «${a.code}» نمی‌تواند والد خودش باشد.`);
    }
  }
  return errors;
}
