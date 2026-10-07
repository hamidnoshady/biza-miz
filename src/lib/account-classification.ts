/**
 * One semantic classification of the chart of accounts — dashboard audit
 * F02, F10, F17.
 *
 * The overview used to call the 1100–1130 numeric block «نقد و بانک» and the
 * cash-flow statement used its own list of three codes; the two disagreed as
 * soon as a business added a petty-cash or a second bank account, and both
 * counted card money still on its way from the PSP (1120) as cash. Receivables
 * were "anything starting 12", which includes recoverable VAT.
 *
 * Every screen that asks "is this cash?" or "is this owed to us by a
 * customer?" now asks this module. It is pure and database-free; callers pass
 * the business's accounts (id, code, parent, type) and get one role per id.
 *
 * Resolution order, so a custom sub-account inherits its parent's meaning:
 *   1. the account's own code or the nearest ancestor's code is a known
 *      system code (WELL_KNOWN_CODES and the template's 11xx/12xx/21xx rows);
 *   2. a numeric code that *extends* a known code (`11101` under `1110`);
 *   3. a four-digit code in a known block (`1115` → bank, `1125` → clearing).
 * Anything else has no role — it is never guessed into cash.
 */
import { WELL_KNOWN_CODES } from "./coa-template";

export type AccountRole =
  /** Notes and coins on hand (صندوق). */
  | "cash"
  /** The business's own bank accounts. */
  | "bank"
  /** Petty-cash floats (تنخواه) — usable, but held by a person. */
  | "petty_cash"
  /** Card/PSP money in transit (کارت‌خوان در راه) — not yet in the bank. */
  | "payment_clearing"
  /** What an ordering platform/marketplace owes after its commission. */
  | "provider_receivable"
  /** Owed to us by customers, including notes and retention (1200, 124x, 1250). */
  | "trade_receivable"
  /** Owed to us by somebody other than a customer (a supplier's refund). */
  | "other_receivable"
  /** Recoverable input VAT — a tax asset, never a customer balance. */
  | "vat_receivable"
  /** What we owe suppliers, consignors, contractors and on issued cheques (21xx). */
  | "trade_payable";

/** Roles that are money the business can spend today (cash and cash equivalents). */
export const USABLE_LIQUIDITY_ROLES: ReadonlySet<AccountRole> = new Set(["cash", "bank", "petty_cash"]);
/** Roles that are settlement in transit: real money, not yet usable. */
export const CLEARING_ROLES: ReadonlySet<AccountRole> = new Set(["payment_clearing", "provider_receivable"]);

/**
 * The accounts an operating expense may be credited from — the one definition
 * of «پرداخت از» (issue #832 §2).
 *
 * «any active `type='asset'` account» is not a payment source: it let an
 * expense post `Dr expense / Cr inventory` or `Cr accounts receivable` through
 * a field that promises cash out of a till or a bank account, silently
 * capitalising spending into stock or collecting a customer's debt for it.
 * What *is* a payment source is the money a business actually pays people
 * with: its till, its banks, a petty-cash float, and the card/PSP settlement
 * account a terminal pays out of. Money owed *to* the business — receivables,
 * recoverable VAT, a platform's settlement due to us — never is, so
 * `provider_receivable` is deliberately absent from this set even though
 * `CLEARING_ROLES` counts it as money in transit.
 *
 * Roles, not codes and not names: a business that renamed 1100, added a second
 * bank under 1110 or imported its own chart keeps working, because what decides
 * eligibility is the account's place in the classification above. A custom
 * liquid account with no recognisable ancestor is *not* guessed into this set —
 * the operator picks the well-known parent, exactly as every other screen that
 * asks "is this cash?" does.
 */
export const EXPENSE_PAYMENT_SOURCE_ROLES: ReadonlySet<AccountRole> = new Set([
  "cash",
  "bank",
  "petty_cash",
  "payment_clearing",
]);

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  cash: "صندوق",
  bank: "بانک",
  petty_cash: "تنخواه",
  payment_clearing: "وجوه در راه کارت‌خوان و درگاه",
  provider_receivable: "طلب از پلتفرم‌های فروش",
  trade_receivable: "دریافتنی از مشتریان",
  other_receivable: "سایر دریافتنی‌ها",
  vat_receivable: "مالیات بر ارزش افزوده قابل استرداد",
  trade_payable: "پرداختنی‌ها",
};

const KNOWN_CODE_ROLES: Record<string, AccountRole> = {
  [WELL_KNOWN_CODES.cash]: "cash",
  [WELL_KNOWN_CODES.bank]: "bank",
  [WELL_KNOWN_CODES.bankClearing]: "payment_clearing",
  "1130": "petty_cash",
  [WELL_KNOWN_CODES.accountsReceivable]: "trade_receivable",
  [WELL_KNOWN_CODES.supplierReceivable]: "other_receivable",
  [WELL_KNOWN_CODES.vatReceivable]: "vat_receivable",
  [WELL_KNOWN_CODES.platformReceivable]: "provider_receivable",
  "1240": "trade_receivable",
  "1250": "trade_receivable",
  [WELL_KNOWN_CODES.accountsPayable]: "trade_payable",
  "2110": "trade_payable",
  "2120": "trade_payable",
  "2130": "trade_payable",
};

/** Four-digit block → role, for a custom account with no recognised ancestor. */
const BLOCK_ROLES: Record<string, AccountRole> = {
  "110": "cash",
  "111": "bank",
  "112": "payment_clearing",
  "113": "petty_cash",
  "120": "trade_receivable",
  "121": "other_receivable",
  "122": "vat_receivable",
  "123": "provider_receivable",
  "124": "trade_receivable",
  "125": "trade_receivable",
  "210": "trade_payable",
  "211": "trade_payable",
  "212": "trade_payable",
  "213": "trade_payable",
};

export interface ClassifiableAccount {
  id: string;
  code: string;
  parentId: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}

function roleTypeMatches(role: AccountRole, type: ClassifiableAccount["type"]): boolean {
  return role === "trade_payable" ? type === "liability" : type === "asset";
}

function roleFromCode(code: string): AccountRole | null {
  const known = KNOWN_CODE_ROLES[code];
  if (known) return known;
  if (!/^\d+$/.test(code)) return null;
  if (code.length > 4) {
    // `11101` extends `1110`: the longest known prefix wins.
    for (let len = code.length - 1; len >= 4; len -= 1) {
      const role = KNOWN_CODE_ROLES[code.slice(0, len)];
      if (role) return role;
    }
    return null;
  }
  if (code.length === 4) return BLOCK_ROLES[code.slice(0, 3)] ?? null;
  return null;
}

/** One role (or null) per account id. */
export function classifyAccounts(accounts: ClassifiableAccount[]): Map<string, AccountRole | null> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, AccountRole | null>();

  const resolve = (account: ClassifiableAccount): AccountRole | null => {
    if (out.has(account.id)) return out.get(account.id) ?? null;
    // 1. own code or nearest ancestor's known code (cycle-safe).
    const seen = new Set<string>();
    let cursor: ClassifiableAccount | undefined = account;
    let role: AccountRole | null = null;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const known = KNOWN_CODE_ROLES[cursor.code];
      if (known) {
        role = known;
        break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    // 2./3. numeric extension or block of the account's own code.
    if (!role) role = roleFromCode(account.code);
    if (role && !roleTypeMatches(role, account.type)) role = null;
    out.set(account.id, role);
    return role;
  };

  for (const account of accounts) resolve(account);
  return out;
}

export function isUsableLiquidity(role: AccountRole | null | undefined): boolean {
  return role != null && USABLE_LIQUIDITY_ROLES.has(role);
}

export function isClearing(role: AccountRole | null | undefined): boolean {
  return role != null && CLEARING_ROLES.has(role);
}

/** May an expense be paid out of an account with this role? (issue #832 §2) */
export function isExpensePaymentSource(role: AccountRole | null | undefined): boolean {
  return role != null && EXPENSE_PAYMENT_SOURCE_ROLES.has(role);
}
