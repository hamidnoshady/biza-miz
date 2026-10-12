/**
 * Issue #866 — which taxpayer-invoicing actions this member may take, as the
 * screen draws them. Framework-free: the same grant the API checks, read from the
 * member's permission list, so a hidden button and a refused request cannot
 * disagree about who is allowed.
 */
import { PERMISSIONS } from "@/lib/permissions";

export interface TaxInvoiceCapabilities {
  view: boolean;
  prepare: boolean;
  send: boolean;
  inquire: boolean;
  amend: boolean;
  cancel: boolean;
  exportRegister: boolean;
  manageSettings: boolean;
}

export function taxInvoiceCapabilitiesFor(permissions: readonly string[]): TaxInvoiceCapabilities {
  const has = (permission: string) => permissions.includes(permission);
  return {
    view: has(PERMISSIONS.taxView),
    prepare: has(PERMISSIONS.taxPrepare),
    send: has(PERMISSIONS.taxSend),
    inquire: has(PERMISSIONS.taxInquiry),
    amend: has(PERMISSIONS.taxAmend),
    cancel: has(PERMISSIONS.taxCancel),
    exportRegister: has(PERMISSIONS.taxExport),
    manageSettings: has(PERMISSIONS.taxManageSettings),
  };
}
