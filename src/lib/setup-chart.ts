/**
 * Shared chart-provisioning vocabulary for the setup wizard (issue #1583).
 *
 * Both the normal Accounts step (`POST /api/setup/accounts`) and the opening
 * step's explicit recovery (`POST /api/setup/opening/chart`) place an industry
 * template through `replaceChartOfAccounts`, and both must translate the same
 * placement refusals into the same Persian sentences. Keeping the map here is
 * what stops the recovery path from growing a second, weaker copy.
 */
import type { AccountTreeError } from "./account-hierarchy";
import { WELL_KNOWN_CODES } from "./coa-template";

export const ACCOUNT_TREE_MESSAGES: Record<AccountTreeError["reason"], string> = {
  too_deep: "ساختار حساب‌ها از سطح «تفصیلی» عمیق‌تر است.",
  parent_cycle: "ساختار والد/فرزند حساب‌ها حلقه دارد.",
  parent_missing: "والد یکی از حساب‌ها در فهرست نیست.",
  duplicate_code: "کد یکی از حساب‌ها تکراری است.",
  type_mismatch: "نوع حساب فرزند باید با نوع والدش یکسان باشد.",
};

/**
 * The codes a recovered chart must actually contain before the recovery is
 * reported as successful — restricted to the ones the industry template itself
 * carries (retail trades keep stock in `items`, not the 1300 GL control).
 *
 * 1100/1110/1120 are the cash/bank/clearing leaves the in-wizard financial
 * accounts attach to; 1300/3900 are what the automatic opening-inventory entry
 * posts against. A template that placed without these is not a usable chart,
 * however many rows it created.
 */
export const REQUIRED_OPENING_CHART_CODES: readonly string[] = [
  WELL_KNOWN_CODES.cash,
  WELL_KNOWN_CODES.bank,
  WELL_KNOWN_CODES.bankClearing,
  WELL_KNOWN_CODES.inventory,
  WELL_KNOWN_CODES.openingEquity,
];
