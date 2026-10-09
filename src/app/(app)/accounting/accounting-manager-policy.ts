import type { AccountingSectionKey } from "./accounting-routes";

/**
 * Sections that consume the full chart list directly from AccountingManager.
 * Fixed assets needs it too — the create form's asset-account picker (15xx)
 * and the disposal proceeds-account picker both choose from the loaded chart.
 */
export function accountingSectionNeedsAccountList(section: AccountingSectionKey): boolean {
  return section === "manual" || section === "expenses" || section === "fixed-assets";
}
