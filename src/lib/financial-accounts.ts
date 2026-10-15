/**
 * «حساب‌های مالی» — the domain rules, framework-free (issue #862).
 *
 * A financial account is *not* a new kind of money: it is a named container the
 * business recognises — a bank account, a till, a petty-cash float, a card
 * terminal — that is linked to exactly one postable GL account in the chart. The
 * ledger stays the only book; this module owns what a container *is*, what may be
 * stored in it, who may read its identifiers, and how its balance and card are
 * computed from posted lines.
 *
 * Everything here is pure, and that is deliberate: the DB-touching service
 * (`financial-accounts-service.ts`) cannot be unit-tested directly in this repo,
 * so every rule a screen or an API can get wrong lives on this side of the line.
 *
 * ## The rule the issue is built around
 *
 * Two financial accounts may never display the same GL balance. That is enforced
 * in three places, in increasing order of authority: the eligible-account list
 * here (which stops offering an account that is already linked), the service's
 * pre-check (which reports *why*), and the database's
 * `uq_financial_accounts_gl_account` (which makes it impossible, including under
 * concurrency).
 */
import {
  ACCOUNT_ROLE_LABELS,
  classifyAccounts,
  type AccountRole,
  type ClassifiableAccount,
} from "./account-classification";
import { formatPersianNumber, toLatinDigits } from "./digits";
import { isUuid } from "./uuid";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const FINANCIAL_ACCOUNT_KINDS = ["bank", "cash", "petty_cash", "pos_psp"] as const;
export type FinancialAccountKind = (typeof FINANCIAL_ACCOUNT_KINDS)[number];

export function isFinancialAccountKind(value: unknown): value is FinancialAccountKind {
  return typeof value === "string" && (FINANCIAL_ACCOUNT_KINDS as readonly string[]).includes(value);
}

export interface FinancialAccountKindMeta {
  /** The singular word the register uses («حساب بانکی»). */
  label: string;
  /** The tab's own word for the whole kind («بانک»). */
  plural: string;
  /** One line for the form, explaining what belongs in this kind. */
  description: string;
  /** The GL role(s) an account of this kind must classify as. */
  roles: ReadonlySet<AccountRole>;
  /** Whether bank metadata is part of the row. */
  bankMetadata: boolean;
  /** Whether terminal/settlement metadata is part of the row. */
  pspMetadata: boolean;
}

const BANK_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>(["bank"]);
const CASH_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>(["cash"]);
const PETTY_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>(["petty_cash"]);

/**
 * A card terminal's money is *in transit* until the PSP settles it: it is either
 * the clearing account (`payment_clearing`, «وجوه در راه») or a bank account for
 * a provider that settles instantly. Anything else — a till, a receivable —
 * would put card money somewhere the business cannot see when it lands.
 */
export const POS_PSP_ELIGIBLE_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>([
  "payment_clearing",
  "bank",
]);

export const FINANCIAL_ACCOUNT_KIND_META: Record<FinancialAccountKind, FinancialAccountKindMeta> = {
  bank: {
    label: "حساب بانکی",
    plural: "بانک",
    description: "حساب‌های بانکی کسب‌وکار؛ هر حساب یک سرفصل جدا در دفتر کل دارد.",
    roles: BANK_ROLES,
    bankMetadata: true,
    pspMetadata: false,
  },
  cash: {
    label: "صندوق",
    plural: "صندوق",
    description: "صندوق نقدی هر شعبه یا هر محل نگهداری وجه نقد.",
    roles: CASH_ROLES,
    bankMetadata: false,
    pspMetadata: false,
  },
  petty_cash: {
    label: "تنخواه",
    plural: "تنخواه",
    description: "تنخواه در اختیار کارکنان برای هزینه‌های کوچک و روزمره.",
    roles: PETTY_ROLES,
    bankMetadata: false,
    pspMetadata: false,
  },
  pos_psp: {
    label: "کارت‌خوان و درگاه",
    plural: "کارت‌خوان و درگاه",
    description: "پایانه‌های کارت‌خوان و درگاه پرداخت، و حساب تسویهٔ هریک.",
    roles: POS_PSP_ELIGIBLE_ROLES,
    bankMetadata: false,
    pspMetadata: true,
  },
};

export function financialAccountKindLabel(kind: FinancialAccountKind): string {
  return FINANCIAL_ACCOUNT_KIND_META[kind].label;
}

/** The role label beside a kind, for the register's summary line. */
export function financialAccountRoleLabel(kind: FinancialAccountKind): string {
  return ACCOUNT_ROLE_LABELS[FINANCIAL_ACCOUNT_KIND_ROLE[kind]];
}

/** The role the kind's own money normally sits in — used for defaults and hints. */
export const FINANCIAL_ACCOUNT_KIND_ROLE: Record<FinancialAccountKind, AccountRole> = {
  bank: "bank",
  cash: "cash",
  petty_cash: "petty_cash",
  pos_psp: "payment_clearing",
};

// ---------------------------------------------------------------------------
// GL eligibility
// ---------------------------------------------------------------------------

/** The minimum an account has to expose to be judged eligible. */
export interface ClassifiableFinancialGlAccount extends ClassifiableAccount {
  name: string;
  currencyCode?: string | null;
  isActive?: boolean;
  /** Whether the account has children — a parent is never postable. */
  hasChildren?: boolean;
}

/** The narrower shape the eligibility verdict needs — an id and its chart facts. */
export type ClassifiableGlForKind = ClassifiableAccount & {
  isActive?: boolean;
  hasChildren?: boolean;
};

/**
 * Why an account cannot back a financial account of this kind.
 *
 * The vocabulary is the service's: it maps each one onto the API's own error code
 * (`financial_account_already_linked`, `gl_account_is_parent`, …), and the form
 * puts the translated sentence beside the field. "It is simply not in the list"
 * is not something a person can act on.
 */
export type GlIneligibilityReason =
  | "already_linked"
  | "inactive"
  | "not_asset"
  | "has_children"
  | "wrong_role"
  | "unclassified";

export interface FinancialGlEligibility {
  /** True when a financial account of this kind may link this account. */
  eligible: boolean;
  /** Why not, or null when it may. */
  reason: GlIneligibilityReason | null;
  /** The role the account classified as, when it classified. */
  role: AccountRole | null;
}

/**
 * Whether one chart account may back a financial account of `kind`.
 *
 * The order of the checks is the order a person would ask them in, and it is what
 * decides which sentence they read: an account already linked to another
 * container is refused for *that* reason, not for being the wrong role.
 */
export function classifyGlAccountForKind(
  account: ClassifiableGlForKind,
  kind: FinancialAccountKind,
  options: { linkedAccountIds?: ReadonlySet<string>; parentAccountIds?: ReadonlySet<string> } = {},
  role?: AccountRole | null,
): FinancialGlEligibility {
  const resolvedRole = role === undefined ? roleOf(account) : role;
  if (options.linkedAccountIds?.has(account.id)) {
    return { eligible: false, reason: "already_linked", role: resolvedRole };
  }
  if (account.isActive === false) return { eligible: false, reason: "inactive", role: resolvedRole };
  if (account.type !== "asset") return { eligible: false, reason: "not_asset", role: resolvedRole };
  if (account.hasChildren || options.parentAccountIds?.has(account.id)) {
    return { eligible: false, reason: "has_children", role: resolvedRole };
  }
  if (!resolvedRole) return { eligible: false, reason: "unclassified", role: null };
  if (!FINANCIAL_ACCOUNT_KIND_META[kind].roles.has(resolvedRole)) {
    return { eligible: false, reason: "wrong_role", role: resolvedRole };
  }
  return { eligible: true, reason: null, role: resolvedRole };
}

/** The role one account classifies as, on its own (no parent context available). */
function roleOf(account: ClassifiableGlForKind): AccountRole | null {
  return classifyAccounts([
    { id: account.id, code: account.code, parentId: account.parentId, type: account.type },
  ]).get(account.id) ?? null;
}

/**
 * The chart accounts a financial account of `kind` may link, from a full chart.
 *
 * Everything is decided from the *whole* chart, because postability is a fact
 * about all of it (a leaf is only a leaf because nothing claims it as a parent)
 * and classification walks ancestors.
 */
export function eligibleGlAccountsForKind<T extends ClassifiableFinancialGlAccount>(
  accounts: readonly T[],
  kind: FinancialAccountKind,
  options: { linkedAccountIds?: ReadonlySet<string>; parentAccountIds?: ReadonlySet<string> } = {},
): T[] {
  return glAccountCandidatesForKind(accounts, kind, options).eligible;
}

/**
 * The same answer, with the refusals kept.
 *
 * Used by the register's empty state («هیچ سرفصل بانکی آزادی نمانده است») and by
 * the diagnostics route; a picker usually needs only the eligible half.
 */
export function glAccountCandidatesForKind<T extends ClassifiableFinancialGlAccount>(
  accounts: readonly T[],
  kind: FinancialAccountKind,
  options: { linkedAccountIds?: ReadonlySet<string>; parentAccountIds?: ReadonlySet<string> } = {},
): { eligible: T[]; refused: { account: T; reason: GlIneligibilityReason }[] } {
  const roles = classifyAccounts(
    accounts.map((account) => ({
      id: account.id,
      code: account.code,
      parentId: account.parentId,
      type: account.type,
    })),
  );
  const parentIds =
    options.parentAccountIds ?? new Set(accounts.filter((account) => account.hasChildren).map((account) => account.id));
  const eligible: T[] = [];
  const refused: { account: T; reason: GlIneligibilityReason }[] = [];
  for (const account of accounts) {
    const verdict = classifyGlAccountForKind(
      account,
      kind,
      { linkedAccountIds: options.linkedAccountIds, parentAccountIds: parentIds },
      roles.get(account.id) ?? null,
    );
    if (verdict.eligible) eligible.push(account);
    else refused.push({ account, reason: verdict.reason ?? "unclassified" });
  }
  return { eligible, refused };
}

// ---------------------------------------------------------------------------
// What may be stored
// ---------------------------------------------------------------------------

/** The fields a create or update request carries. Unknown fields are ignored. */
export interface FinancialAccountFieldsInput {
  kind?: unknown;
  name?: unknown;
  code?: unknown;
  glAccountId?: unknown;
  currencyCode?: unknown;
  locationId?: unknown;
  isDefault?: unknown;
  description?: unknown;
  notes?: unknown;
  bankName?: unknown;
  bankBranchName?: unknown;
  accountNumber?: unknown;
  cardNumber?: unknown;
  iban?: unknown;
  accountHolder?: unknown;
  settlementReference?: unknown;
  pspProvider?: unknown;
  terminalNumber?: unknown;
  merchantNumber?: unknown;
  settlementAccountId?: unknown;
  settlementDelayDays?: unknown;
}

export interface FinancialAccountProblem {
  code: string;
  /** The form field the message belongs beside, when it is one field's fault. */
  field: string | null;
}

const TEXT_LIMITS: Record<string, number> = {
  name: 120,
  code: 32,
  description: 400,
  notes: 2000,
  bankName: 80,
  bankBranchName: 120,
  accountNumber: 40,
  cardNumber: 32,
  iban: 32,
  accountHolder: 120,
  settlementReference: 120,
  pspProvider: 80,
  terminalNumber: 40,
  merchantNumber: 40,
};

function textProblem(field: string, value: unknown, required: boolean): FinancialAccountProblem | null {
  if (value === undefined || value === null || value === "") {
    return required ? { code: `${field}_required`, field } : null;
  }
  if (typeof value !== "string") return { code: `invalid_${field}`, field };
  const trimmed = value.trim();
  if (required && !trimmed) return { code: `${field}_required`, field };
  if (trimmed.length > (TEXT_LIMITS[field] ?? 200)) return { code: `${field}_too_long`, field };
  return null;
}

/**
 * The digits a bank identifier is allowed to contain.
 *
 * Stored as text, never as a number: a card number with a leading zero is not a
 * smaller number, it is a *different* card. Persian and Arabic-Indic digits are
 * converted on the way in (`toLatinDigits`) because a Persian keyboard produces
 * them and an identifier stored in Persian digits is a string nothing else in
 * the system can match.
 */
export function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = toLatinDigits(value).replace(/[\s-]/g, "").trim();
  return clean || null;
}

const IBAN_SHAPE = /^IR\d{24}$/;
const CARD_SHAPE = /^\d{16}$/;

/**
 * Everything a create/update request must satisfy before the database sees it.
 *
 * Returns the FIRST problem, because a form shows one message per field and a
 * list of six is not more helpful than the first one. Field-level codes
 * (`iban_invalid`) exist so the screen can put the message beside the input
 * that caused it, while the shared dictionary in `financial-account-errors.ts`
 * holds the Persian text.
 */
export function financialAccountInputProblem(
  input: FinancialAccountFieldsInput,
  options: { partial?: boolean } = {},
): FinancialAccountProblem | null {
  const partial = options.partial === true;
  const kindProvided = input.kind !== undefined && input.kind !== null;
  if (!partial && !kindProvided) return { code: "kind_required", field: "kind" };
  if (kindProvided && !isFinancialAccountKind(input.kind)) return { code: "invalid_kind", field: "kind" };
  const kind = isFinancialAccountKind(input.kind) ? input.kind : null;

  for (const [field, required] of [
    // A create always needs a name; a PATCH needs one only when it is *sending*
    // one — `name: ""` is a request to blank the name, which no account may be.
    ["name", !partial || input.name !== undefined],
    ["code", false],
    ["description", false],
    ["notes", false],
    ["bankName", false],
    ["bankBranchName", false],
    ["accountNumber", false],
    ["cardNumber", false],
    ["iban", false],
    ["accountHolder", false],
    ["settlementReference", false],
    ["pspProvider", false],
    ["terminalNumber", false],
    ["merchantNumber", false],
  ] as const) {
    const problem = textProblem(field, input[field], required);
    if (problem) return problem;
  }

  if (!partial || input.glAccountId !== undefined) {
    if (typeof input.glAccountId !== "string" || !isUuid(input.glAccountId)) {
      return { code: "gl_account_required", field: "glAccountId" };
    }
  }

  if (input.currencyCode !== undefined && input.currencyCode !== null && input.currencyCode !== "") {
    if (typeof input.currencyCode !== "string" || !/^[A-Za-z]{3}$/.test(input.currencyCode.trim())) {
      return { code: "invalid_currency", field: "currencyCode" };
    }
  }

  if (input.locationId !== undefined && input.locationId !== null && input.locationId !== "") {
    if (typeof input.locationId !== "string" || !isUuid(input.locationId)) {
      return { code: "invalid_location", field: "locationId" };
    }
  }

  const iban = normalizeIdentifier(input.iban);
  if (iban && !IBAN_SHAPE.test(iban.toUpperCase())) return { code: "iban_invalid", field: "iban" };
  const card = normalizeIdentifier(input.cardNumber);
  if (card && !CARD_SHAPE.test(card)) return { code: "card_number_invalid", field: "cardNumber" };

  if (kind && !FINANCIAL_ACCOUNT_KIND_META[kind].bankMetadata) {
    // The database refuses these too; saying it here is what puts the message on
    // the field rather than in a generic banner.
    for (const field of ["bankName", "bankBranchName", "accountNumber", "cardNumber", "iban", "accountHolder"]) {
      const value = input[field as keyof FinancialAccountFieldsInput];
      if (value !== undefined && value !== null && value !== "") {
        return { code: "kind_metadata_mismatch", field };
      }
    }
  }
  if (kind && !FINANCIAL_ACCOUNT_KIND_META[kind].pspMetadata) {
    for (const field of ["pspProvider", "terminalNumber", "merchantNumber", "settlementDelayDays"]) {
      const value = input[field as keyof FinancialAccountFieldsInput];
      if (value !== undefined && value !== null && value !== "") {
        return { code: "kind_metadata_mismatch", field };
      }
    }
  }
  if (
    input.settlementAccountId !== undefined &&
    input.settlementAccountId !== null &&
    input.settlementAccountId !== "" &&
    (typeof input.settlementAccountId !== "string" || !isUuid(input.settlementAccountId))
  ) {
    return { code: "invalid_settlement_account", field: "settlementAccountId" };
  }
  if (input.settlementDelayDays !== undefined && input.settlementDelayDays !== null && input.settlementDelayDays !== "") {
    const days = Number(input.settlementDelayDays);
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      return { code: "invalid_settlement_delay", field: "settlementDelayDays" };
    }
  }
  for (const field of ["isDefault"] as const) {
    const value = input[field];
    if (value !== undefined && typeof value !== "boolean") {
      return { code: `invalid_${field}`, field };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------

/** The identifying numbers a member without the master-data capability sees masked. */
export interface FinancialAccountSensitiveFields {
  accountNumber: string | null;
  cardNumber: string | null;
  iban: string | null;
  accountHolder: string | null;
  settlementReference: string | null;
  merchantNumber: string | null;
  terminalNumber: string | null;
}

/**
 * The register's own row shape.
 *
 * `balance` is always present and always *derived*: the service fills it from
 * `journal_lines` on every read. There is no stored balance to fall out of date
 * with the ledger, which is the issue's central requirement.
 */
export interface FinancialAccountRecord extends FinancialAccountSensitiveFields {
  id: string;
  kind: FinancialAccountKind;
  code: string | null;
  name: string;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
  currencyCode: string;
  locationId: string | null;
  locationName: string | null;
  isActive: boolean;
  isDefault: boolean;
  description: string | null;
  notes: string | null;
  bankName: string | null;
  bankBranchName: string | null;
  pspProvider: string | null;
  settlementAccountId: string | null;
  settlementAccountName: string | null;
  settlementDelayDays: number | null;
  /** Exact Rial, as decimal text — read off the ledger, never stored. */
  balance: string;
  archivedAt: string | null;
  archivedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The row as a browser gets it: the numbers masked when the member may not see
 * them, and the flag that says which it is, so a screen can hint «برای دیدن
 * شمارهٔ کامل، دسترسی مدیریت حساب‌ها لازم است» rather than looking broken.
 */
export interface SensitiveDetailsVisibility {
  canViewSensitive: boolean;
}

/**
 * The register's one-line name for an account.
 *
 * A business can hold three rows called «حساب جاری»; the bank is what tells them
 * apart at a glance, so a bank row carries it. One definition, used by the
 * accounts screen and the transfer pickers alike — two screens spelling the same
 * account differently is how a person picks the wrong one.
 */
export function financialAccountDisplayLabel(
  account: Pick<FinancialAccountRecord, "name" | "kind" | "bankName">,
): string {
  if (account.kind === "bank" && account.bankName) return `${account.name} — ${account.bankName}`;
  return account.name;
}

/** «همهٔ شعبه‌ها» for a container the whole business shares. */
export function financialAccountScopeLabel(locationName: string | null | undefined): string {
  return locationName ?? "همهٔ شعبه‌ها";
}

/** Keep the last `visible` characters, mask the rest. Empty input stays empty. */
export function maskIdentifier(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length <= visible) return "•".repeat(text.length);
  const tail = text.slice(-visible);
  return `${"•".repeat(Math.min(text.length - visible, 8))}${tail}`;
}

/** The same row with its identifying numbers masked for a caller who may not see them. */
export function maskSensitiveFinancialDetails<T extends FinancialAccountSensitiveFields>(
  row: T,
  visibility: SensitiveDetailsVisibility,
): T {
  if (visibility.canViewSensitive) return row;
  return {
    ...row,
    accountNumber: maskIdentifier(row.accountNumber),
    cardNumber: maskIdentifier(row.cardNumber),
    iban: maskIdentifier(row.iban),
    settlementReference: maskIdentifier(row.settlementReference, 6),
    merchantNumber: maskIdentifier(row.merchantNumber, 4),
  };
}

// ---------------------------------------------------------------------------
// Balances — always a sum over posted lines
// ---------------------------------------------------------------------------

export interface LedgerLineAmount {
  debit: string;
  credit: string;
}

function lineAmount(value: string): bigint {
  return BigInt(value || "0");
}

/** `sum(debit − credit)` over the given lines, as exact text. */
export function balanceFromLines(lines: readonly LedgerLineAmount[]): string {
  let total = 0n;
  for (const line of lines) total += lineAmount(line.debit) - lineAmount(line.credit);
  return total.toString();
}

export function sumDebits(lines: readonly LedgerLineAmount[]): string {
  let total = 0n;
  for (const line of lines) total += lineAmount(line.debit);
  return total.toString();
}

export function sumCredits(lines: readonly LedgerLineAmount[]): string {
  let total = 0n;
  for (const line of lines) total += lineAmount(line.credit);
  return total.toString();
}

export function addRialText(left: string, right: string): string {
  return (BigInt(left || "0") + BigInt(right || "0")).toString();
}

// ---------------------------------------------------------------------------
// The account card (صورت حساب)
// ---------------------------------------------------------------------------

export interface AccountCardMovementInput {
  entryId: string;
  entryDate: string;
  memo: string | null;
  /** What posted it — `manual`, `financial_transfer`, `payment`, … */
  sourceType: string | null;
  /** The id of the document behind the entry (`journal_entries.source_id`). */
  journalSourceId: string | null;
  debit: string;
  credit: string;
  /** When the entry was reversed, if it was — the card shows it struck through. */
  reversedAt?: string | null;
  /** The other side of the entry, named for the card's own column. */
  counterparty?: string;
}

export interface AccountCardMovement extends AccountCardMovementInput {
  /** The running balance after this movement — exact integer text. */
  balance: string;
}

export interface AccountCard {
  opening: string;
  rows: AccountCardMovement[];
  totalDebit: string;
  totalCredit: string;
  closing: string;
  /** `closing − (opening + debit − credit)`; 0 when the card reconciles. */
  reconciliationDifference: string;
}

/**
 * A card (صورت حساب) from an opening balance and the period's movements.
 *
 * The closing balance is computed from the opening plus the movements AND
 * asserted against the ledger's own closing figure by the caller — the
 * `reconciliationDifference` this returns is what the screen shows when the two
 * disagree (they cannot, but a card that cannot state its own reconciliation is
 * a card nobody can audit).
 */
export function accountCardFromMovements(
  opening: string,
  movements: readonly AccountCardMovementInput[],
  ledgerClosing?: string,
): AccountCard {
  let running = BigInt(opening);
  const rows: AccountCardMovement[] = movements.map((movement) => {
    running += lineAmount(movement.debit) - lineAmount(movement.credit);
    return { ...movement, balance: running.toString() };
  });
  const totalDebit = sumDebits(movements);
  const totalCredit = sumCredits(movements);
  const closing = running.toString();
  const expected = ledgerClosing ?? addRialText(addRialText(opening, totalDebit), `-${BigInt(totalCredit)}`);
  return {
    opening,
    rows,
    totalDebit,
    totalCredit,
    closing,
    reconciliationDifference: (BigInt(closing) - BigInt(expected)).toString(),
  };
}

/** A balance as the business reads money: Toman, Persian digits, grouped. */
export function formatBalanceToman(balanceText: string, unit: "toman" | "rial" = "toman"): string {
  const value = BigInt(balanceText);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const shown = unit === "rial" ? magnitude : magnitude / 10n;
  return `${negative ? "−" : ""}${formatPersianNumber(shown)}`;
}

/** Whether a balance is exactly zero — what the archive rule asks. */
export function isZeroBalance(balanceText: string): boolean {
  return BigInt(balanceText) === 0n;
}

/** Guard for amounts arriving as text from a client: unsigned, canonical, in range. */
export function isRialAmountText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = toLatinDigits(value).replace(/[٬,\s]/g, "");
  if (!/^\d{1,15}$/.test(text)) return false;
  return true;
}

