import type { AccountingSectionKey } from "./accounting-routes";

/**
 * Sections that consume the full chart list directly from AccountingManager.
 * Fixed assets needs it too — the create form's asset-account picker (15xx)
 * and the disposal proceeds-account picker both choose from the loaded chart.
 * Opening balances (issue #867) needs it for its line editor's account picker.
 */
export function accountingSectionNeedsAccountList(section: AccountingSectionKey): boolean {
  return (
    section === "manual" ||
    section === "expenses" ||
    section === "fixed-assets" ||
    section === "opening-balances"
  );
}
