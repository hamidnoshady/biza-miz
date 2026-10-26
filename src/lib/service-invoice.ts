/**
 * Service invoices — the sale document of a trade that sells work, not goods.
 *
 * An engineering/contracting business (issue #799) and a service company
 * (`service_saas`) have no shelf, no serial and no recipe: what they invoice is
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
export const SERVICE_INVOICE_INDUSTRIES = ["service_saas", "architecture_construction"] as const;
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
