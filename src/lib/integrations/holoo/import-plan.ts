/**
 * Phase 26 (issue #125) Wave 3 — the pure planning half of base-data import.
 *
 * Before any write, the importer works out *what* it would do: which goods and
 * customers are new (vs already mapped), and which Holoo accounts map onto the
 * industry's seed chart of accounts rather than being recreated. This module is
 * the pure, unit-tested part of that decision; import-service.ts applies it.
 */
import type { AccountType } from "../../coa-template";
import type { MappedAccount, MappedGoods, MappedPerson } from "./mappers";

// ---------------------------------------------------------------------------
// Goods / customers — "new" is simply "not already mapped".
// ---------------------------------------------------------------------------

export interface EntityPlan<T> {
  /** Rows to create (not previously mapped). */
  toCreate: T[];
  /** Count of rows already mapped and therefore skipped. */
  skipped: number;
}

export function planGoods(goods: MappedGoods[], alreadyMapped: ReadonlySet<string>): EntityPlan<MappedGoods> {
  const toCreate: MappedGoods[] = [];
  let skipped = 0;
  for (const row of goods) {
    if (alreadyMapped.has(row.remoteId)) skipped += 1;
    else toCreate.push(row);
  }
  return { toCreate, skipped };
}

export function planPersons(persons: MappedPerson[], alreadyMapped: ReadonlySet<string>): EntityPlan<MappedPerson> {
  const toCreate: MappedPerson[] = [];
  let skipped = 0;
  for (const row of persons) {
    if (alreadyMapped.has(row.remoteId)) skipped += 1;
    else toCreate.push(row);
  }
  return { toCreate, skipped };
}

// ---------------------------------------------------------------------------
// Accounts — align with the seed chart, don't blindly recreate it.
// ---------------------------------------------------------------------------

/** Iranian account-coding convention: the leading digit names the type. */
export function holooAccountType(code: string, nature?: string | null): AccountType {
  const c = code.trim();
  if (nature?.toLowerCase() === "credit") {
    // A credit-nature account is a liability, equity or revenue source.
    if (/^[23]/.test(c)) return /^3/.test(c) ? "equity" : "liability";
    return "revenue";
  }
  const first = c[0];
  switch (first) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "revenue";
    case "5":
    case "6":
    case "7":
      return "expense";
    default:
      return "asset";
  }
}

export interface AccountImportPlan {
  /** Holoo accounts whose code already exists in the seed chart — map, don't recreate. */
  mappedToSeed: MappedAccount[];
  /** Holoo accounts with codes absent from the seed chart — create fresh, parents first. */
  toCreate: MappedAccount[];
  /** Accounts whose parent is unavailable or belongs to an invalid/cyclic chain. */
  orphaned: MappedAccount[];
  /** Remote identities already linked by an earlier run. */
  skipped: number;
}

export function planAccountImport(
  holooAccounts: MappedAccount[],
  seedCodes: ReadonlySet<string>,
  alreadyMapped: ReadonlySet<string> = new Set(),
): AccountImportPlan {
  const mappedToSeed: MappedAccount[] = [];
  const pending: MappedAccount[] = [];
  const alreadyMappedCodes = new Set<string>();
  let skipped = 0;

  for (const account of holooAccounts) {
    if (alreadyMapped.has(account.remoteId)) {
      alreadyMappedCodes.add(account.code);
      skipped += 1;
    } else if (seedCodes.has(account.code)) {
      mappedToSeed.push(account);
    } else {
      pending.push(account);
    }
  }

  // Resolve parents before children regardless of workbook/source row order.
  // Anything left after topological sorting has a missing parent or a cycle;
  // fail closed rather than silently creating a detached chart account.
  const knownParents = new Set([...seedCodes, ...alreadyMappedCodes]);
  const toCreate: MappedAccount[] = [];
  while (pending.length > 0) {
    const readyIndexes = pending
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => !account.parentCode || knownParents.has(account.parentCode));
    if (readyIndexes.length === 0) break;
    for (const { account } of readyIndexes) {
      toCreate.push(account);
      knownParents.add(account.code);
    }
    for (const { index } of readyIndexes.reverse()) pending.splice(index, 1);
  }

  return { mappedToSeed, toCreate, orphaned: pending, skipped };
}
