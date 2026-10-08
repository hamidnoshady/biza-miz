import type { AccountingSectionKey } from "./accounting-routes";

/** Sections that consume the full chart list directly from AccountingManager. */
export function accountingSectionNeedsAccountList(section: AccountingSectionKey): boolean {
  return section === "manual" || section === "expenses";
}
