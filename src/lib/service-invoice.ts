/**
 * Service invoices — the sale document of a trade that sells work, not goods.
 *
 * An engineering/contracting business (issue #799), a service company
 * (`service_saas`) and an advertising agency (issue #1128) have no shelf, no
 * serial and no recipe: what they invoice is
 * a described service at a quantity, a unit price and a VAT rate. The retail
 * invoice (`retail-invoice-service.ts`) already gives every other trade a
 * numbered, printable, voidable, payable document that is an `orders` row, so a
 * service invoice is one more *line kind* on it — `kind: "service"` — rather
 * than a parallel invoices table. That is also what makes the Moodian tax
 * records, receipts, receivables and the invoice list work for these trades
 * without a second implementation.
 *
 * What a service line adds to the existing kinds is the absence of stock: no
 * `item_stock` decrement, no COGS entry, no catalogue row. The line is a free
 * description, and the one accounting decision it carries is *which revenue
 * account it credits*, chosen from the short list below.
 *
 * Framework-free (no `pg`, no Next) like `accessories.ts`, so the invoice
 * screen previews with the same function the server settles with.
 */
import type { Industry } from "./industries";
import { WELL_KNOWN_CODES } from "./coa-template";
import { computeAccessorySalePrice, type AccessorySalePriceBreakdown } from "./accessories";

/** The trades that invoice services from `/accounting/pos`. */
export const SERVICE_INVOICE_INDUSTRIES = [
  "service_saas",
  "architecture_construction",
  "advertising_agency",
] as const;
export type ServiceInvoiceIndustry = (typeof SERVICE_INVOICE_INDUSTRIES)[number];

export function isServiceInvoiceIndustry(industry: Industry): industry is ServiceInvoiceIndustry {
  return (SERVICE_INVOICE_INDUSTRIES as readonly string[]).includes(industry);
}

export interface ServiceRevenueAccount {
  code: string;
  label: string;
}

/**
 * The revenue accounts a service line may credit, per trade. The first entry is
 * the default — what a line credits when the operator does not choose. Every
 * code is seeded by the trade's chart of accounts (`coa-template.ts`); the
 * service company's three have no `WELL_KNOWN_CODES` key because nothing else
 * posts to them by name.
 */
export const SERVICE_REVENUE_ACCOUNTS: Record<ServiceInvoiceIndustry, readonly ServiceRevenueAccount[]> = {
  service_saas: [
    { code: "4500", label: "درآمد اشتراک و مصرف" },
    { code: "4510", label: "درآمد پیاده‌سازی و مشاوره" },
    { code: "4520", label: "درآمد طراحی و خدمات وب‌سایت" },
  ],
  architecture_construction: [
    { code: WELL_KNOWN_CODES.aecDesignRevenue, label: "درآمد خدمات طراحی و مهندسی" },
    { code: WELL_KNOWN_CODES.aecSupervisionRevenue, label: "درآمد نظارت و مشاوره" },
    { code: WELL_KNOWN_CODES.aecConstructionRevenue, label: "درآمد پیمانکاری و اجرا" },
  ],
  /**
   * Issue #1128 — the agency's four service revenues, in the order the chart
   * lists them, so the first (4640) is the default a line credits when the
   * operator does not choose. That is the same account `accounting-posting-rules.ts`
   * names for the trade and the one `coa-template.ts` seeds, which is what makes
   * the picker on the invoice screen and the ledger agree without either
   * restating a code.
   *
   * Which of the four an operator picks is the accounting fact §D asks for: a
   * campaign retainer and a media recharge on one invoice land in 4640 and 4660,
   * so the campaign P&L can read agency fees and media separately instead of
   * inferring the split from the size of a line.
   */
  advertising_agency: [
    { code: WELL_KNOWN_CODES.agencyCampaignRevenue, label: "درآمد خدمات تبلیغاتی و مدیریت کمپین" },
    { code: WELL_KNOWN_CODES.agencyCreativeRevenue, label: "درآمد طراحی، برندینگ و تولید محتوا" },
    { code: WELL_KNOWN_CODES.agencyMediaRevenue, label: "درآمد رسانه (خرید فضا و زمان و کارمزد مدیریت)" },
    { code: WELL_KNOWN_CODES.agencyEventRevenue, label: "درآمد روابط عمومی، رویداد و اجرا" },
  ],
};

/** The account a service line credits when no code is asked for. */
export function defaultServiceRevenueCode(industry: ServiceInvoiceIndustry): string {
  return SERVICE_REVENUE_ACCOUNTS[industry][0].code;
}

/**
 * Resolve the revenue account of a service line. An unknown code is refused
 * rather than coerced to the default: crediting a different account than the one
 * the operator picked is a silent misstatement of the books.
 */
export function resolveServiceRevenueCode(
  industry: ServiceInvoiceIndustry,
  requested: string | null | undefined,
): string {
  if (requested === undefined || requested === null || requested === "") {
    return defaultServiceRevenueCode(industry);
  }
  const allowed = SERVICE_REVENUE_ACCOUNTS[industry].find((account) => account.code === requested);
  if (!allowed) throw new Error("حساب درآمد انتخاب‌شده برای این کسب‌وکار مجاز نیست.");
  return allowed.code;
}

export const SERVICE_DESCRIPTION_MAX_LENGTH = 200;

/** The description printed on the invoice line, trimmed; refuses an empty or over-long one. */
export function normalizeServiceDescription(description: unknown): string {
  const text = typeof description === "string" ? description.trim() : "";
  if (!text) throw new Error("شرح خدمت لازم است.");
  if (text.length > SERVICE_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`شرح خدمت نباید بیش از ${SERVICE_DESCRIPTION_MAX_LENGTH} نویسه باشد.`);
  }
  return text;
}

export interface ServiceSalePriceInput {
  unitPrice: number;
  quantity: string;
  discount?: number;
  vatPercent: number;
}

/**
 * Quantity × unit price, less the line discount, plus VAT — each stage rounded
 * to whole Rial on the previous stage's rounded value, the rule every retail
 * line follows so a receipt's lines add up to its total. A service has no
 * different arithmetic from a fungible good, so this is that function under the
 * name the service screen and the posting path use.
 */
export function computeServiceSalePrice(input: ServiceSalePriceInput): AccessorySalePriceBreakdown {
  return computeAccessorySalePrice(input);
}

/* --------------------------------------------------------------------------- */
/* Issue #1128 §D — the pass-through recharge line                              */
/* --------------------------------------------------------------------------- */

/**
 * The account a pass-through recharge line credits.
 *
 * It is not in `SERVICE_REVENUE_ACCOUNTS` and must never be added to it: 1270 is an
 * **asset**, and `account-classification.ts` deliberately leaves it unclassified
 * because it is an unbilled pass-through rather than an invoice the client owes yet.
 * A line that credits it is not recognising revenue — it is collecting money the
 * agency advanced, which is the whole of §D's net presentation. Putting 1270 in the
 * revenue picker would let any agency line credit it as though it were income, and a
 * revenue report summing `revenueCode` would then count a client's own media money as
 * the agency's sales.
 */
export const PASS_THROUGH_RECHARGE_ACCOUNT = WELL_KNOWN_CODES.agencyReimbursableClientCost;

/**
 * Which trades may issue one.
 *
 * Only the advertising agency has 1270 in its chart: 0259 seeds it for
 * `advertising_agency`, and `accountIdsByCode` throws for a code the tenant's chart
 * does not carry. Letting a SaaS company emit a pass-through line would therefore
 * fail at the posting rule with a missing-account error, which is a worse place to
 * find out than here — and it would be a line whose meaning the trade has no account
 * for, which is the same objection §D's registers raise against another industry
 * being *defaulted* rather than refused.
 */
export const PASS_THROUGH_RECHARGE_INDUSTRIES = ["advertising_agency"] as const;

export type PassThroughRechargeIndustry = (typeof PASS_THROUGH_RECHARGE_INDUSTRIES)[number];

export function isPassThroughRechargeIndustry(industry: Industry): industry is PassThroughRechargeIndustry {
  return (PASS_THROUGH_RECHARGE_INDUSTRIES as readonly string[]).includes(industry);
}

/**
 * The credit account for a pass-through line, or null for a trade that has none.
 *
 * Returns rather than throws so the caller decides the words: the invoice service
 * turns null into its own refusal, and a test can assert the vocabulary without
 * catching.
 */
export function passThroughRechargeCreditCode(industry: Industry): string | null {
  return isPassThroughRechargeIndustry(industry) ? PASS_THROUGH_RECHARGE_ACCOUNT : null;
}

/**
 * The VAT a pass-through line carries when the member does not state one: none.
 *
 * This is a default and not a rule, and the distinction matters. Whether recovering
 * a disbursement is a taxable supply is a question of jurisdiction *and* of the
 * contract — in some engagements the agency buys media in its own name and resells
 * it, in others it pays as the client's agent and merely collects the money back.
 * Software that picked one would be asserting a tax position it cannot know, so the
 * line defaults to zero and a member who knows their contract says otherwise sets a
 * rate explicitly.
 *
 * Zero is also the conservative direction: it can never create a VAT liability the
 * business does not owe, whereas defaulting to the trade's rate would — and an
 * over-declared liability is a filing to correct, not a line to edit.
 */
export const PASS_THROUGH_DEFAULT_VAT_PERCENT = 0;

/**
 * Resolve the credit account of a pass-through line, refusing a trade that has none.
 *
 * The throwing sibling of `passThroughRechargeCreditCode`, for the one caller that
 * must not continue: the invoice service. A trade whose chart does not carry 1270
 * would otherwise reach `accountIdsByCode` inside the posting rule and fail there with
 * a missing-account error — true, but a long way from the reason, and after the
 * invoice's other lines had already been written in the same transaction.
 */
export function resolvePassThroughCreditCode(industry: Industry): string {
  const code = passThroughRechargeCreditCode(industry);
  if (!code) {
    throw new Error("بازدریافت هزینه از کارفرما برای این نوع کسب‌وکار تعریف نشده است.");
  }
  return code;
}
