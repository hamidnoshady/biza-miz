/**
 * Issue #867 — accountant opening balances & fiscal carry-forward, the pure
 * part.
 *
 * Two questions live here, framework-free and unit-testable:
 *
 *  1. **What is a valid opening set** — the line rules a manual (or imported)
 *     set must satisfy before it may move draft → review → approved.
 *
 *  2. **What the next year opens with** — the carry-forward rule. Given the
 *     prior year's closing trial balance plus the subledgers that own their
 *     attribution (A/R by customer, A/P by supplier, the cheque register, the
 *     fixed-asset register), build the next year's opening lines so that:
 *
 *      - only balance-sheet balances carry forward. **Revenue and expense
 *        accounts never carry as ordinary opening balances** — the prior
 *        year's result (revenue − expense, or whatever the close left in
 *        retained earnings) becomes one equity line;
 *      - the A/R and A/P *control* accounts are replaced by one line per
 *        party with a non-zero balance, so the attribution survives the
 *        transition (and the residual an attribution misses becomes a named,
 *        unattributed line, never a silent difference);
 *      - cheques and fixed assets carry **per-item** (cheque serial / Sayad,
 *        asset id + cost + accumulated depreciation) whenever the register
 *        and the GL agree to the Rial — and fall back to the account total
 *        with a note when they do not;
 *      - the result is balanced *by construction* (a trial balance that
 *        balances yields opening debits = opening credits), and
 *        `reconcileOpeningToClosing` can prove it against the prior close.
 *
 * All money is exact — `bigint` Rial through this module, never a float.
 * The DB-touching half is `opening-balances-service.ts`.
 */
import type { AccountType } from "./coa-template";

// ---------------------------------------------------------------------------
// Line validation (manual / imported sets)
// ---------------------------------------------------------------------------

export interface OpeningLineInput {
  accountId: string;
  debit: number;
  credit: number;
  partyType?: "customer" | "supplier" | "cheque" | "fixed_asset" | "inventory" | null;
  partyId?: string | null;
  reference?: string | null;
  sourceNote?: string | null;
}

/** Caps: a set is a document a person reviews, not a file of arbitrary rows. */
export const OPENING_LINES_MAX = 500;
export const OPENING_NOTE_MAX = 500;

export type OpeningSetProblem =
  | "no_lines"
  | "too_many_lines"
  | "invalid_line"
  | "too_few_lines"
  | "single_account_set"
  | "not_balanced";

/** The rows that carry an amount — what a set is, before balancing. */
export function nonZeroOpeningLines<T extends { debit: number; credit: number }>(
  lines: readonly T[],
): T[] {
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

/** Signed net of a row: debit − credit, as bigint (exact for any Rial value). */
export function openingLineNet(line: { debit: number | bigint; credit: number | bigint }): bigint {
  return BigInt(line.debit) - BigInt(line.credit);
}

/** Debit/credit totals as bigint. */
export function openingLineTotals(
  lines: readonly { debit: number | bigint; credit: number | bigint }[],
): { totalDebit: bigint; totalCredit: bigint; difference: bigint } {
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const l of lines) {
    totalDebit += BigInt(l.debit);
    totalCredit += BigInt(l.credit);
  }
  return { totalDebit, totalCredit, difference: totalDebit - totalCredit };
}

/**
 * What is wrong with this set, or `null` when it may be submitted.
 *
 * The order is the order a person fixes problems in. `lines` is the
 * *submitted* set; the service normalises (drops zero rows, trims notes)
 * before asking.
 */
export function openingSetProblem(
  lines: readonly OpeningLineInput[],
): OpeningSetProblem | null {
  const rows = nonZeroOpeningLines(lines);
  if (rows.length === 0) return "no_lines";
  if (rows.length > OPENING_LINES_MAX) return "too_many_lines";
  for (const l of rows) {
    if (
      !l.accountId ||
      !Number.isSafeInteger(l.debit) ||
      l.debit < 0 ||
      !Number.isSafeInteger(l.credit) ||
      l.credit < 0 ||
      (l.debit !== 0 && l.credit !== 0)
    ) {
      return "invalid_line";
    }
  }
  if (rows.length < 2) return "too_few_lines";
  if (new Set(rows.map((l) => l.accountId)).size < 2) return "single_account_set";
  if (openingLineTotals(rows).difference !== 0n) return "not_balanced";
  return null;
}

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

/** One account of the prior year's closing trial balance (signed net). */
export interface CarryForwardAccount {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** debit − credit through the close, bigint Rial. */
  closingNet: bigint;
}

/** A party's open balance at the year-end date. */
export interface CarryForwardPartyBalance {
  /** customers.id / suppliers.id — the subledger's own key. */
  subledgerId: string;
  /** parties.id when the alias is linked to a party (the directory key). */
  partyId: string | null;
  name: string;
  /** Positive = the party owes the business (A/R) / the business owes the party (A/P). */
  balance: bigint;
}

export interface CarryForwardCheque {
  chequeId: string;
  direction: "receivable" | "payable";
  /** Which GL account this cheque sits in (on hand / in collection / issued). */
  accountId: string;
  serialNumber: string;
  sayadId: string | null;
  counterpartyName: string;
  amount: bigint;
}

export interface CarryForwardFixedAsset {
  assetId: string;
  name: string;
  /** The account the asset's cost is carried in (its `asset_account_id`, or the fixed-asset root). */
  accountId: string;
  cost: bigint;
  accumulatedDepreciation: bigint;
  /** 'journal' | 'opening_balance' | 'unlinked' — the register's own provenance. */
  acquisitionSource: string;
}

/** The accounts the rule names; the service resolves them from codes. */
export interface CarryForwardAccountIds {
  accountsReceivable: string | null;
  accountsPayable: string | null;
  accumulatedDepreciation: string | null;
  /** The equity account the prior year's result lands in. */
  retainedEarnings: string | null;
}

export interface CarryForwardInput {
  accounts: readonly CarryForwardAccount[];
  arByCustomer: readonly CarryForwardPartyBalance[];
  apBySupplier: readonly CarryForwardPartyBalance[];
  openCheques: readonly CarryForwardCheque[];
  fixedAssets: readonly CarryForwardFixedAsset[];
  accountIds: CarryForwardAccountIds;
}

export interface CarryForwardLine {
  accountId: string;
  debit: bigint;
  credit: bigint;
  partyType: "customer" | "supplier" | "cheque" | "fixed_asset" | "inventory" | null;
  partyId: string | null;
  reference: string | null;
  sourceNote: string | null;
}

export interface CarryForwardProposal {
  lines: CarryForwardLine[];
  totalDebit: bigint;
  totalCredit: bigint;
  balanced: boolean;
  /** Persian notes for the set: every fallback the rule had to take. */
  notes: string[];
}

function line(
  accountId: string,
  net: bigint,
  extra: Partial<CarryForwardLine> = {},
): CarryForwardLine | null {
  if (net === 0n) return null;
  return {
    accountId,
    debit: net > 0n ? net : 0n,
    credit: net < 0n ? -net : 0n,
    partyType: null,
    partyId: null,
    reference: null,
    sourceNote: null,
    ...extra,
  };
}

/**
 * The carry-forward rule. `input.accounts` must be the *complete* closing
 * trial balance of the prior year (every account, zero net included) — the
 * balance check at the end is only meaningful against the whole book.
 */
export function buildCarryForwardProposal(input: CarryForwardInput): CarryForwardProposal {
  const lines: CarryForwardLine[] = [];
  const notes: string[] = [];
  const handled = new Set<string>();

  const byId = new Map(input.accounts.map((a) => [a.accountId, a]));
  const netOf = (accountId: string | null): bigint =>
    accountId ? (byId.get(accountId)?.closingNet ?? 0n) : 0n;

  // -- A/R: one line per customer, the control replaced by its detail. -----
  if (input.accountIds.accountsReceivable) {
    const arId = input.accountIds.accountsReceivable;
    const attributed = input.arByCustomer.reduce((sum, c) => sum + c.balance, 0n);
    const control = netOf(arId);
    for (const c of input.arByCustomer) {
      const l = line(arId, c.balance, {
        partyType: "customer",
        partyId: c.partyId,
        reference: c.partyId ? null : c.name,
        sourceNote: `اعتبار ${c.name}`,
      });
      if (l) lines.push(l);
    }
    const residual = control - attributed;
    if (residual !== 0n) {
      const l = line(arId, residual, {
        sourceNote:
          input.arByCustomer.length === 0
            ? "تفکیک مشتری برای سال قبل موجود نیست؛ کل حساب جابه‌سازی شد"
            : "باقیمانده بدون تخصیص مشتری (مغایرت دفترک و حساب کل)",
      });
      if (l) {
        lines.push(l);
        if (input.arByCustomer.length > 0) {
          notes.push("مجموع بدهی مشتریان با حساب کل حساب‌های دریافتنی برابر نیست؛ باقیمانده به‌صورت سطر بدون تخصیص جابه‌سازی شد.");
        }
      }
    }
    handled.add(arId);
  }

  // -- A/P: the mirror. ------------------------------------------------------
  if (input.accountIds.accountsPayable) {
    const apId = input.accountIds.accountsPayable;
    const attributed = input.apBySupplier.reduce((sum, s) => sum + s.balance, 0n);
    const control = netOf(apId);
    for (const s of input.apBySupplier) {
      // The business's debt to the supplier is a credit balance: signed net is negative.
      const l = line(apId, -s.balance, {
        partyType: "supplier",
        partyId: s.partyId,
        reference: s.partyId ? null : s.name,
        sourceNote: `بدهی به ${s.name}`,
      });
      if (l) lines.push(l);
    }
    const residual = control + attributed;
    if (residual !== 0n) {
      const l = line(apId, residual, {
        sourceNote:
          input.apBySupplier.length === 0
            ? "تفکیک تأمین‌کننده برای سال قبل موجود نیست؛ کل حساب جابه‌سازی شد"
            : "باقیمانده بدون تخصیص تأمین‌کننده (مغایرت دفترک و حساب کل)",
      });
      if (l) {
        lines.push(l);
        if (input.apBySupplier.length > 0) {
          notes.push("مجموع بدهی به تأمین‌کنندگان با حساب کل حساب‌های پرداختنی برابر نیست؛ باقیمانده به‌صورت سطر بدون تخصیص جابه‌سازی شد.");
        }
      }
    }
    handled.add(apId);
  }

  // -- Cheques: per-cheque lines when the register and the GL agree. --------
  const chequeByAccount = new Map<string, CarryForwardCheque[]>();
  for (const ch of input.openCheques) {
    const list = chequeByAccount.get(ch.accountId) ?? [];
    list.push(ch);
    chequeByAccount.set(ch.accountId, list);
  }
  for (const [accountId, cheques] of chequeByAccount) {
    const total = cheques.reduce((sum, c) => sum + c.amount, 0n);
    const account = byId.get(accountId);
    if (!account) continue; // a cheque sitting in an account the chart no longer has: leave it to the GL below
    // Receivables are debit balances; payables are credit balances (negative net).
    const expected = account.type === "asset" ? total : -total;
    if (expected === account.closingNet && expected !== 0n) {
      for (const ch of cheques) {
        const l = line(accountId, expected > 0n ? ch.amount : -ch.amount, {
          partyType: "cheque",
          partyId: ch.chequeId,
          reference: ch.sayadId ? `Sayad ${ch.sayadId} / ${ch.serialNumber}` : ch.serialNumber,
          sourceNote: `چک ${ch.direction === "receivable" ? "دریافتی" : "پرداختنی"} ${ch.counterpartyName}`,
        });
        if (l) lines.push(l);
      }
      handled.add(accountId);
    } else {
      notes.push("مجموع چک‌های باز با حساب کل چک‌ها برابر نیست؛ کل حساب جابه‌سازی شد.");
    }
  }

  // -- Fixed assets: per-asset cost lines + one accumulated-depreciation line,
  //     when the register and the GL agree; otherwise the account totals. ----
  const accDepId = input.accountIds.accumulatedDepreciation;
  const costByAccount = new Map<string, bigint>();
  let totalAccumDep = 0n;
  for (const asset of input.fixedAssets) {
    costByAccount.set(asset.accountId, (costByAccount.get(asset.accountId) ?? 0n) + asset.cost);
    totalAccumDep += asset.accumulatedDepreciation;
  }
  const perAssetAgrees =
    costByAccount.size > 0 &&
    [...costByAccount.entries()].every(
      ([accountId, cost]) => byId.get(accountId)?.closingNet === cost,
    ) &&
    (accDepId === null || (byId.get(accDepId)?.closingNet ?? 0n) === -totalAccumDep);
  if (perAssetAgrees) {
    for (const asset of input.fixedAssets) {
      const l = line(asset.accountId, asset.cost, {
        partyType: "fixed_asset",
        partyId: asset.assetId,
        reference: asset.name,
        sourceNote: `دارایی ثابت «${asset.name}» — منبع: ${asset.acquisitionSource}`,
      });
      if (l) {
        lines.push(l);
        handled.add(asset.accountId);
      }
    }
    if (accDepId) {
      const l = line(accDepId, -totalAccumDep, {
        sourceNote: "استهلاک انباشته دارایی‌های ثابت",
      });
      if (l) {
        lines.push(l);
        handled.add(accDepId);
      }
    }
  } else if (costByAccount.size > 0) {
    notes.push("منزلک دارایی‌های ثابت با حساب‌های کل برابر نیست؛ کل حساب‌ها جابه‌سازی شد.");
  }

  // -- The rest of the balance sheet, account by account. --------------------
  for (const account of input.accounts) {
    if (handled.has(account.accountId)) continue;
    if (account.type !== "asset" && account.type !== "liability" && account.type !== "equity") {
      continue; // revenue & expense: their net becomes the equity line below
    }
    const l = line(account.accountId, account.closingNet, {
      sourceNote: account.type === "asset" && account.code === "1300" ? "موجودی افتتاحیه" : null,
    });
    if (l) lines.push(l);
  }

  // -- The prior year's result → one equity line. ----------------------------
  // netRev + netExp is (by the trial balance balancing) the negative of the
  // balance sheet's net — so this single line is what makes the set balance,
  // and it is zero exactly when the year was already closed into equity.
  let netRev = 0n;
  let netExp = 0n;
  for (const account of input.accounts) {
    if (account.type === "revenue") netRev += account.closingNet;
    else if (account.type === "expense") netExp += account.closingNet;
  }
  const profit = -(netRev + netExp);
  if (profit !== 0n && input.accountIds.retainedEarnings) {
    lines.push(
      line(input.accountIds.retainedEarnings, -profit, {
        sourceNote: "سود (زیان) سال قبل — انتقال به سرمایه",
      })!,
    );
  } else if (profit !== 0n) {
    notes.push("حساب سود و زیان انباشته در سرفصل وجود ندارد؛ نتیجه سال قبل جابه‌سازی نشد — تراز این مجموعه برقرار نمی‌شود.");
  }

  const { totalDebit, totalCredit } = openingLineTotals(lines);
  return { lines, totalDebit, totalCredit, balanced: totalDebit === totalCredit, notes };
}

// ---------------------------------------------------------------------------
// Reconciliation: prior close vs next open
// ---------------------------------------------------------------------------

/**
 * One comparison row. `key` is stable enough to be a report row id:
 * `account:<accountId>`, `party:<type>:<partyId>` or
 * `party:<type>:unattributed:<accountId>`.
 */
export interface ReconciliationRow {
  key: string;
  label: string;
  expectedDebit: bigint;
  expectedCredit: bigint;
  actualDebit: bigint;
  actualCredit: bigint;
  /** expected net − actual net; 0 = matches to the Rial. */
  difference: bigint;
  matched: boolean;
}

export interface OpeningReconciliation {
  matched: boolean;
  rows: ReconciliationRow[];
  totalExpectedDebit: bigint;
  totalExpectedCredit: bigint;
  totalActualDebit: bigint;
  totalActualCredit: bigint;
}

interface Aggregated {
  byAccount: Map<string, { debit: bigint; credit: bigint }>;
  byParty: Map<string, { debit: bigint; credit: bigint; label: string }>;
  totalDebit: bigint;
  totalCredit: bigint;
}

function aggregateLines(lines: readonly {
  accountId: string;
  debit: bigint;
  credit: bigint;
  partyType: string | null;
  partyId: string | null;
  reference: string | null;
  sourceNote: string | null;
}[]): Aggregated {
  const byAccount = new Map<string, { debit: bigint; credit: bigint }>();
  const byParty = new Map<string, { debit: bigint; credit: bigint; label: string }>();
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
    const acc = byAccount.get(l.accountId) ?? { debit: 0n, credit: 0n };
    acc.debit += l.debit;
    acc.credit += l.credit;
    byAccount.set(l.accountId, acc);
    if (l.partyType) {
      const key = `party:${l.partyType}:${l.partyId ?? "unattributed"}`;
      const party = byParty.get(key) ?? { debit: 0n, credit: 0n, label: l.reference ?? l.sourceNote ?? l.partyType };
      party.debit += l.debit;
      party.credit += l.credit;
      byParty.set(key, party);
    }
  }
  return { byAccount, byParty, totalDebit, totalCredit };
}

/**
 * Whether an opening set matches the prior close it was generated from.
 * `expectedLines` is the carry-forward proposal (or, for a manual set, the
 * prior year's closing lines the accountant claims to have read); `actualLines`
 * is the set as it stands. Comparison is per account and per attributed
 * party — both must agree to the Rial for `matched`.
 */
export function reconcileOpeningToClosing(
  expectedLines: readonly {
    accountId: string;
    debit: bigint;
    credit: bigint;
    partyType: string | null;
    partyId: string | null;
    reference: string | null;
    sourceNote: string | null;
  }[],
  actualLines: readonly {
    accountId: string;
    debit: bigint;
    credit: bigint;
    partyType: string | null;
    partyId: string | null;
    reference: string | null;
    sourceNote: string | null;
  }[],
): OpeningReconciliation {
  const expected = aggregateLines(expectedLines);
  const actual = aggregateLines(actualLines);

  const rows: ReconciliationRow[] = [];
  const accountKeys = new Set([...expected.byAccount.keys(), ...actual.byAccount.keys()]);
  for (const accountId of accountKeys) {
    const e = expected.byAccount.get(accountId) ?? { debit: 0n, credit: 0n };
    const a = actual.byAccount.get(accountId) ?? { debit: 0n, credit: 0n };
    const difference = e.debit - e.credit - (a.debit - a.credit);
    rows.push({
      key: `account:${accountId}`,
      label: accountId,
      expectedDebit: e.debit,
      expectedCredit: e.credit,
      actualDebit: a.debit,
      actualCredit: a.credit,
      difference,
      matched: difference === 0n,
    });
  }
  const partyKeys = new Set([...expected.byParty.keys(), ...actual.byParty.keys()]);
  for (const key of partyKeys) {
    const e = expected.byParty.get(key) ?? { debit: 0n, credit: 0n, label: "" };
    const a = actual.byParty.get(key) ?? { debit: 0n, credit: 0n, label: e.label };
    const difference = e.debit - e.credit - (a.debit - a.credit);
    rows.push({
      key,
      label: a.label || e.label,
      expectedDebit: e.debit,
      expectedCredit: e.credit,
      actualDebit: a.debit,
      actualCredit: a.credit,
      difference,
      matched: difference === 0n,
    });
  }
  rows.sort((x, y) => x.key.localeCompare(y.key));

  return {
    matched: rows.every((r) => r.matched),
    rows,
    totalExpectedDebit: expected.totalDebit,
    totalExpectedCredit: expected.totalCredit,
    totalActualDebit: actual.totalDebit,
    totalActualCredit: actual.totalCredit,
  };
}
